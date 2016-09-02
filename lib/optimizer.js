"use strict";

const async = require('async'),
    childProcess = require("child_process"),
    mongodb = require("mongodb"),
    mongodbUri = require('mongodb-uri'),
    MongoSampler = require('./mongo_sampler'),
    MongoIndex = require("./mongo_index"),
    QueryProfile = require("./query_profile"),
    QuerySet = require('./query_set'),
    IndexSet = require('./index_set'),
    flat = require('flat'),
    underscore = require("underscore");

const _index = Symbol("_index");

/**
 * The MongoOptimizer is the root class for all Mongo Dynamic Indexer functionality. It coordinates the other classes
 * to produce the recommendations.
 */
class MongoOptimizer
{
    /**
     * Create an optimizer object with the given options.
     *
     * @param {object} options An object containing all of the options for the optimizer.
     */
    constructor(options)
    {
        const self = this;
        self.options = options;
    }


    /**
     * This method connects to the database. It must be called before anything else in the optimizer can be run.
     *
     * @param {function(err)} done A callback function. This will receive any connection errors from connecting to the
     *                             database.
     */
    connect(done)
    {
        const self = this;
        mongodb.MongoClient.connect(self.options.database, function(err, db)
        {
            if (err)
            {
                return done(err);
            }
            else
            {
                self.db = db;

                db.on('close', function(err)
                {
                    // Kill the process
                    console.error(err);
                    process.exit(2);
                });

                return done();
            }
        });
    }


    /**
     * This method loads all of the data for the optimizer from the database.
     *
     * That may include both cardinality data and query profiles.
     *
     * This must be run after MongoOptimizer::connect()
     *
     * @param {function(err)} done Callback after all of the optimizer data is loaded.
     */
    loadOptimizerData(done)
    {
        const self = this;
        const collection = self.db.collection(self.options.collection);

        collection.find({}).limit(1).toArray().then(function(results)
        {
            // If there are no results, then we are operating on a fresh database!
            if (results.length == 0)
            {
                self.sampler = new MongoSampler(self.db, self.options, null);
                self.querySet = new QuerySet({}, self.sampler, self.options);
                return done();
            }

            const data = results[0];
            if(data.sampler)
            {
                self.sampler = new MongoSampler(self.db, self.options, data.sampler);
            }
            else
            {
                self.sampler = new MongoSampler(self.db, self.options, null);
            }

            if (data.queryProfiles)
            {
                self.querySet = new QuerySet({queryProfiles: data.queryProfiles}, self.sampler, self.options);
            }
            else if (data.querySet)
            {
                self.querySet = new QuerySet(data.querySet, self.sampler, self.options);
            }
            else
            {
                self.querySet = new QuerySet(null, self.sampler, self.options);
            }

            return done();
        }, done).catch(done)
    }


    /**
     * This method saves the data for the optimizer to the database. Basically includes all internal state
     * for the optimizer.
     *
     * That may include both cardinality data and query profiles.
     *
     * @param {function()} done A callback after the data has been saved.
     */
    saveOptimizerData(done)
    {
        const self = this;
        const collection = self.db.collection(self.options.collection);

        const objectToSave = {
            querySet: self.querySet.toJSON(),
            sampler: self.sampler.toJSON()
        };

        collection.findOneAndUpdate({}, objectToSave,{upsert: true}).then(function(changed)
        {
            return done();
        }, done).catch(done);
    }

    /**
     * This method ensures that Mongo profiling is turned on if it needs to be turned on.
     *
     * @param {function()} done A callback after profiling has been enabled.
     */
    setProfilingLevel(done)
    {
        const self = this;

        if (self.options.profileLevel != -1)
        {
            // First, set the profiling level
            self.db.command( {profile: self.options.profileLevel}, null, function (err, result)
            {
                if (err)
                {
                    return done(err);
                }

                if (result.ok !== 1)
                {
                    return done(new Error(`Error while setting the profile level on the database. Got result:  ${JSON.stringify(result)}`))
                }
                else
                {
                    return done();
                }
            });
        }
        else
        {
            return done();
        }
    }


    /**
     * This method starts the  main loop for the optimizer. It connects to the databases system.profile collection
     * and starts tailing it and processing mongos profile object as it goes.
     *
     * @param {function(err)} done Callback function for after the main loop has been started.
     */
    startOptimizer(done)
    {
        const self = this;

        self.setProfilingLevel(function (err)
        {
            if (err)
            {
                return done(err);
            }


            const profile = self.db.collection("system.profile");

            var cursor = profile.find({
                op: "query",
                ns: {$regex: "^[^\\.]+\\.(?!system|\\$cmd)"}
            }, {
                tailable: true,
                awaitdata: true,
                timeout: false
            });

            const queue = async.queue(function(mongoProfile, next)
            {
                async.nextTick(function()
                {
                    self.processMongoProfile(mongoProfile, function (err)
                    {
                        if (err)
                        {
                            console.error(err);
                            return next(err);
                        }

                        return next();
                    });
                });
            });

            cursor.each(function(err, item)
            {
                if (err)
                {
                    console.error(err);
                    // process.exit(1);
                }
                else if(item === null)
                {
                    console.error("Cursor for documents in system.profile collection returned nothing.");
                    // process.exit(1);
                }
                else
                {
                    queue.push(item);
                }
            });

            // At the same time, every 30 seconds, we synchronize the indexes with our current optimal layout
            function syncIndexes()
            {
                // This function handles the query finishing
                function finish(err)
                {
                    if (err)
                    {
                        console.error(err);
                    }

                    setTimeout(syncIndexes, self.options.indexSynchronizationInterval * 1000);
                }

                // First, we remove any old query profiles
                self.querySet.removeOldQueryProfiles();

                // Save before, because the synchronize step can take a long time,
                // and we don't want to lose all the query profiles gathered so far
                self.saveOptimizerData(function (err)
                {
                    if (err)
                    {
                        return finish(err);
                    }

                    try
                    {
                        // Perform the synchronization. Internally, this triggers the random sampling of your database.
                        self.synchronizeIndexes(function (err)
                        {
                            if (err)
                            {
                                return finish(err);
                            }

                            // Also save after, so that we don't lose any of the cached sampling statitics gathered during the first step.
                            self.saveOptimizerData(function (err)
                            {
                                if (err)
                                {
                                    return finish(err);
                                }

                                return finish();
                            });
                        });
                    }
                    catch(err)
                    {
                        return finish(err);
                    }
                });
            }

            syncIndexes();

            return done();
        });
    }


    /**
     * This method creates an IndexSet with all of the indexes that currently exist for our collections
     *
     * @param {function(err, indexSet)} done A callback function which will receive the IndexSet object containing all of the indexes.
     */
    getExistingIndexes(done)
    {
        const self = this;
        const collections = underscore.uniq(underscore.map(self.queryProfiles, queryProfile => queryProfile.collectionName));

        // For each collection, obtain the list of existing indexes for that collection
        async.mapSeries(collections, function(collectionName, next)
        {
            // Get the collection
            const collection = self.db.collection(collectionName);

            // Get the existing indexes
            collection.listIndexes().toArray().then(function(results)
            {
                const existingIndexes = underscore.filter(underscore.map(results, result => new MongoIndex(result.key, collectionName, result.name)), index => !index.isIDOnly);
                return next(null, existingIndexes)
            }, next).catch(next);
        }, function(err, allExistingIndexes)
        {
            if (err)
            {
                return done(err);
            }

            return done(null, new IndexSet(underscore.flatten(allExistingIndexes)));
        });
    }


    /**
     * This method will go through the reduced set of indexes for our query profiles, and
     * compare them to the set of indexes that we have in the database. It will then, for
     * each collection, produce its recommended index plan. This includes which indexes to
     * drop, which to keep, and which to create new.
     *
     * @param {function(err, collectionChanges)} done A callback function which will receive the results.
     */
    getRecommendedIndexChanges(done)
    {
        const self = this;

        self.getExistingIndexes(function(err, currentIndexSet)
        {
            if (err)
            {
                return done(err);
            }

            self.querySet.computeOptimalIndexSet(function(err, recommendedIndexSet)
            {
                if (err)
                {
                    return done(err);
                }

                const collectionChanges = IndexSet.getRecommendedIndexChanges(recommendedIndexSet, currentIndexSet);
                return done(null, collectionChanges);
            });
        });
    }

    /**
     * This method is used to process a single Mongo Profile object - the type that are stored in the system.profile collection,
     * or returned when you use the .explain() method on a cursor.
     *
     * It will extract the query for that profile, determine if its a known query or a new one. If its a new one it stores it.
     *
     * If its a known query, it will further examine the profile object to see what indexes Mongo actually used for this query.
     * It compares this with the indexes that it expects Mongo to use for this query. If Mongo used none of the expected indexes,
     * it will print an error.
     *
     * @param {object} mongoProfile A JSON mongo profile object from the system.profile
     * @param {function(err)} done A callback after the mongo profile has been processed.
     *
     */
    processMongoProfile(mongoProfile, done)
    {
        const self = this;

        const queryProfiles = QueryProfile.createQueryProfilesFromMongoProfile(mongoProfile, self.options);
        async.eachSeries(queryProfiles, function (queryProfile, next)
        {
            // If this query only contains _id or is empty entirely, ignore it
            if (queryProfile.isIDOnly || queryProfile.isEmpty)
            {
                return next();
            }

            // First add it to the query set
            const existingQueryProfile = self.querySet.addQueryProfile(queryProfile);

            existingQueryProfile.getCardinalitiesForIndexOptimization(self.sampler, function(err)
            {
                if (err)
                {
                    return next(err);
                }

                // Now check to see if it used the indexes we think it should have
                const indexesPendingCreation = underscore.any(existingQueryProfile.reducedIndexes, (index) => !index.doesIndexExist());

                // If we don't know for sure that the index even exists, then we shouldn't trigger an error message
                if (indexesPendingCreation)
                {
                    return next();
                }
                // Or if there are no indexes for the query, ignore that as well
                if (existingQueryProfile.reducedIndexes.length == 0)
                {
                    console.error("Query has no indexes!");
                    console.error(existingQueryProfile);
                    console.error(existingQueryProfile.reducedIndexes);
                    return next();
                }

                const usedCorrectIndex = existingQueryProfile.didMongoProfileUseIndex(mongoProfile);
                if (!usedCorrectIndex)
                {
                    console.log("Missed the correct index in: ", mongoProfile.ns);
                    console.log("Query:");
                    console.log(mongoProfile.query);
                    console.log("Profile");
                    console.log(existingQueryProfile);
                    console.log("Used indexes:");
                    console.log(JSON.stringify(QueryProfile.getUsedIndexesInMongoProfile(mongoProfile), null, 2));
                    console.log("Expected index:");
                    console.log(JSON.stringify(existingQueryProfile.reducedIndexes, null, 2));
                    console.log()
                }

                return next();
            });
        }, done);
    }

    /**
     * This method just formats and prints the collectionChanges object created by MongoOptimizer::getRecommendedIndexChanges
     *
     * @param {object} collectionChanges The results produced from MongoOptimizer::getRecommendedIndexChanges
     * @param {String} indent A string containing the number of spaces wanted for indentation at the start of the line.
     */
    printChangeSummary(collectionChanges, indent)
    {
        const self = this;

        console.log(`${indent}${collectionChanges.collectionName}`);
        if (!self.options.showChangesOnly || collectionChanges.create.length > 0)
        {
            console.log(`${indent}    Create:`);
            const sortedCreateIndexes = underscore.sortBy(collectionChanges.create, (index) => JSON.stringify(index));
            sortedCreateIndexes.forEach(function(index)
            {
                index.printIndexData(`${indent}        `, true);
                console.log("");
            });
        }

        if (!self.options.showChangesOnly)
        {
            console.log("");
            console.log(`${indent}    Keep:`);
            const sortedKeepIndexes = underscore.sortBy(collectionChanges.keep, (index) => JSON.stringify(index));
            sortedKeepIndexes.forEach(function(index, n)
            {
                index.printIndexData(`${indent}        `, true);
                console.log("");
            });
        }

        if (!self.options.showChangesOnly || collectionChanges.drop.length > 0)
        {
            console.log("");
            console.log(`${indent}    Drop:`);
            const sortedDropIndexes = underscore.sortBy(collectionChanges.drop, (index) => JSON.stringify(index));
            sortedDropIndexes.forEach(function (index)
            {
                index.printIndexData(`${indent}        `, true);
                console.log("");
            });
        }
    }

    /**
     * This method creates a new index using the Mongo shell. It is done this way to circumvent a bug in the NodeJS Mongo driver
     * which doesn't allow creating indexes with periods in them, like {"names.name": 1}
     *
     * @param {String} collectionName The name of the collection to create the index on
     * @param {MongoIndex} index The index object describing the index.
     * @param {String} indexName The name of the index
     * @param {function(err)} done A callback that will be called once the index has been created.
     */
    createIndexSubProcess(collectionName, index, indexName, done)
    {
        const self = this;
        const parsed = mongodbUri.parse(self.options.database);

        const resultPrefix = 'index-creation-result:';
        const usernameArgument = parsed.username ? [`--username`, `${parsed.username}`] : [];
        const passwordArgument = parsed.password ? [`--password`, `${parsed.password}`] : [];
        const hostArgument = parsed.hosts[0].host ? [`--host`, `${parsed.hosts[0].host}`] : [];
        const portArgument = parsed.hosts[0].port ? [`--port`, `${parsed.hosts[0].port}`] : [];
        const databaseArgument = parsed.database ? [`${parsed.database}`] : [];
        const commandArgument = [`--eval`, `print("${resultPrefix}" + JSON.stringify(db.${collectionName}.createIndex(${JSON.stringify(index)}, {background: true, name: "${indexName}"})));`];
        const allArguments = underscore.flatten([usernameArgument, passwordArgument, hostArgument, portArgument, databaseArgument, commandArgument]);
        const command = `mongo ${allArguments.join(" ")}`;

        childProcess.execFile("mongo", allArguments, {env: process.env}, function(err, output)
        {
            if (err)
            {
                return done(err);
            }
            const outputPos = output.indexOf(resultPrefix);

            if (outputPos === -1)
            {
                return done(new Error(`Error creating the index through the Mongo Shell. Executed command:\n${command}\nGot output:\n${output}\n`))
            }

            const jsonOutput = output.substr(outputPos + resultPrefix.length);
            let result = null;
            try
            {
                result = JSON.parse(jsonOutput);
            }
            catch(err)
            {
                return done(new Error(`Error parsing the JSON output from creating the index on the Mongo Shell. Executed command:\n${command}\n Got output:\n${output}\n`))
            }

            if (result.ok)
            {
                return done();
            }
            else if(result.code === 17280)
            {
                // This is an error that a particular value in the database is too large to index. This means that we must have not caught that value
                // when we did our random sample to determine field cardinalities and maximum value lengths.
                const fields = Object.keys(index);
                self.sampler.getCollectionStatistics(collectionName, function(err, collectionStatistics)
                {
                    if (err)
                    {
                        return done(err);
                    }

                    // Get the field that already has the longest maximum length. This field is probably the trouble maker
                    const fieldToAlter = underscore.max(fields, (field) => collectionStatistics.fieldStatistics[field].longest);

                    // We change this fields statistics so that its longest known value is longer then whats indexable.
                    // Other machinery will then react to do the best we can with this field, potentially by creating a
                    // hash index
                    collectionStatistics.fieldStatistics[fieldToAlter].mode = 'hash';

                    return done();
                });
            }
            else
            {
                return done(new Error(`Error while creating index through the Mongo Shell. Executed command:\n${command}\nGot result:\n${JSON.stringify(result, null, 2)}`));
            }
        });
    }

    /**
     * This method checks what the current indexes are, compares it to the recommended indexes for the currently known queries,
     * and implements the changes if index changing is enabled. If changes are disabled, it will just print its recommended changes
     * without implementing them.
     *
     * @param {function(err)} done A callback after all of the indexes have been synchronized.
     */
    synchronizeIndexes(done)
    {
        const self = this;

        function printIndexReportStart()
        {
            console.log("==========================================================");
            console.log("==========================================================");
            console.log("Index Report ", new Date().toString());
        }

        function printIndexReportFinish()
        {
            console.log("Index Report Finished");
            console.log("==========================================================");
            console.log("==========================================================");
        }

        if(self.options.simple)
        {
            self.querySet.computeOptimalIndexSet(function(err, recommendedIndexSet)
            {
                if (err)
                {
                    return done(err);
                }

                printIndexReportStart();
                console.log("\n");
                recommendedIndexSet.print();
                console.log("\n");
                printIndexReportFinish();

                return done();
            });
        }
        else
        {

            self.getRecommendedIndexChanges(function (err, collectionsToChange)
            {
                if (err)
                {
                    return done(err);
                }

                // sort the collections to change
                collectionsToChange = underscore.sortBy(collectionsToChange, (collectionChanges) => (collectionChanges.collectionName));

                if (self.options.showChangesOnly)
                {
                    // First see if there are any changes at all
                    let changes = false;
                    // Print a summary of the changes that are being made first
                    collectionsToChange.forEach(function (collectionChanges)
                    {
                        if (collectionChanges.create.length > 0 || collectionChanges.drop.length > 0)
                        {
                            changes = true;
                        }
                    });

                    // If there are changes, print them
                    if (changes)
                    {
                        printIndexReportStart();

                        // Print a summary of the changes that are being made first
                        collectionsToChange.forEach(function (collectionChanges)
                        {
                            if (collectionChanges.create.length > 0 || collectionChanges.drop.length > 0)
                            {
                                self.printChangeSummary(collectionChanges, "    ");
                            }
                        });

                        printIndexReportFinish();
                    }
                }
                else
                {
                    printIndexReportStart();

                    // Print a summary of the changes that are being made first
                    collectionsToChange.forEach(function (collectionChanges)
                    {
                        self.printChangeSummary(collectionChanges, "    ");
                    });

                    printIndexReportFinish();
                }


                // If we don't need to do the changes, then don't go any further
                if (!self.options.doChanges)
                {
                    return done();
                }

                async.eachSeries(collectionsToChange, function (collectionChanges, next)
                {
                    // Get the collection
                    const collection = self.db.collection(collectionChanges.collectionName);
                    async.eachSeries(collectionChanges.create, function (index, next)
                    {
                        collection.createIndex(index, {name: index.mongoIndexName, background: true}, function (err)
                        {
                            if (err)
                            {
                                self.createIndexSubProcess(collectionChanges.collectionName, index, index.mongoIndexName, function (subProcessError)
                                {
                                    if (subProcessError)
                                    {
                                        console.error(`Create index error for index ${JSON.stringify(index)}. Index may need to be created manually: ${subProcessError}`);
                                        return next();
                                    }

                                    return next();
                                });
                            }
                            else
                            {
                                return next();
                            }
                        });
                    }, function (err)
                    {
                        if (err)
                        {
                            return next(err);
                        }

                        // See the list of indexes we don't need anymore (dangerous!)
                        async.eachSeries(collectionChanges.drop, function (index, next)
                        {
                            collection.dropIndex(index.mongoIndexName, {}, function (err)
                            {
                                if (err)
                                {
                                    console.error(`Drop index error for index ${JSON.stringify(index)}. Index may need to be dropped manually: ${err}`);
                                    return next();
                                }
                                else
                                {
                                    return next();
                                }
                            });
                        }, next);
                    });
                }, function (err)
                {
                    if (err)
                    {
                        return done(err);
                    }

                    return done();
                });
            });
        }
    }
}

module.exports = MongoOptimizer;
