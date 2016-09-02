"use strict";

const async = require("async"),
    CollectionStatistics = require('./collection_statistics'),
    MongoIndex = require('./mongo_index'),
    farmhash = require('farmhash'),
    flat = require("flat"),
    IndexStatistics = require('./index_statistics'),
    underscore = require("underscore");

const _options = Symbol("_options");

/**
 *  This class is a tool that is used for sampling data from collections in order to get cardinality information
 */
class MongoSampler
{
    /**
     * Creates the mongo sampler. This should just be a singleton
     *
     * @param {object} db The Mongo database
     * @param {object} options The global application options
     * @param {object} data This is the data for the sampler as it was stored in the database
     */
    constructor(db, options, data)
    {
        this.db = db;

        if (!data)
        {
            data = {};
        }

        if (!data.collectionStatistics)
        {
            this.collectionStatistics = {};
        }
        else
        {
            this.collectionStatistics = underscore.mapObject(data.collectionStatistics, function(value)
            {
                return new CollectionStatistics(value);
            });
        }

        if (!data.indexStatistics)
        {
            this.indexStatistics = {};
        }
        else
        {
            this.indexStatistics = underscore.mapObject(data.indexStatistics, function(value)
            {
                return new IndexStatistics(value);
            });
        }


        this[_options] = options;
    }


    /**
     * Saves the internal state of the sampler to the database. Can be used to save intermediary results
     *
     */
    save(callback)
    {
        const self = this;
        const collection = self.db.collection(self[_options].collection);

        const objectToSave = {
            sampler: self.toJSON()
        };

        collection.findOneAndUpdate({}, {$set: objectToSave}, {upsert: true}).then(function(changed)
        {
            return callback();
        }, callback).catch(callback);
    }


    /**
     * Converts the internal state of the sampler into a JSON object that is safe to be saved to a database.
     *
     * @returns {object} A JSON object representing the internal state of the sampler
     */
    toJSON()
    {
        // Convert every field with a period in it with something else before saving it to mongo
        return {
            collectionStatistics: underscore.mapObject(this.collectionStatistics, function(collectionStatistics)
            {
                return collectionStatistics.toJSON();
            }),
            indexStatistics: underscore.mapObject(this.indexStatistics, function(indexStatistics)
            {
                return indexStatistics.toJSON();
            })
        }
    }


    /**
     * This method returns a CollectionStatistics object for the given collection. If there is already stats available,
     * and they are fresh, it will just return those.
     *
     * Otherwise, it will sample random objects from the database and build up the statistics.
     *
     * @param {string} collectionName The name of the collection to get statistics for.
     * @param {function(err, collectionStatistics)} next A callback which will receive the statistics object
     */
    getCollectionStatistics(collectionName, next)
    {
        const self = this;

        // See if we already have cardinality information for the requested collection
        if(self.collectionStatistics[collectionName])
        {
            if (Math.abs(self.collectionStatistics[collectionName].lastSampleTime.getTime() - Date.now()) < (self[_options].cardinalityUpdateInterval * 1000 * 60 * 60 * 24))
            {
                return next(null, this.collectionStatistics[collectionName]);
            }
        }

        // Get the distinct values for the field in question
        const collection = self.db.collection(collectionName);
        const numberOfObjectsToSample = self[_options].sampleSize / 10;
        const uniqueValueHashes = {};
        const longest = {};

        self.sampleCollection(numberOfObjectsToSample, {}, collection, null, function(object, next)
        {
            const flattened = flat(object);
            // Now, transfer all of the values of the flattened object into arrays of unique values
            Object.keys(flattened).forEach(function(flattenedKey)
            {
                // We simplify the key by combining array references, like .0 and .1 and .2, into a simple .[]
                let simplifiedKey = flattenedKey.replace(/\.\d+/g, ".[]");

                // If the value is an empty array (a special case), then add a .[] to the key
                if (underscore.isArray(flattened[flattenedKey]))
                {
                    simplifiedKey += ".[]";
                }

                if (!uniqueValueHashes[simplifiedKey])
                {
                    uniqueValueHashes[simplifiedKey] = new Set();
                }

                let value = flattened[flattenedKey];
                if (!value)
                {
                    value = null;
                }

                const valueString = String(value);
                const valueHash = farmhash.fingerprint32(valueString);
                uniqueValueHashes[simplifiedKey].add(valueHash);

                if (longest[simplifiedKey])
                {
                    longest[simplifiedKey] = Math.max(longest[simplifiedKey], valueString.length);
                }
                else
                {
                    longest[simplifiedKey] = valueString.length;
                }
            });

            return next();
        }, function(err)
        {
            if (err)
            {
                return next(err);
            }

            let allKnownArrayPrefixes = [];
            const fieldStatistics = {};
            underscore.each(uniqueValueHashes, function(uniqueValueHashes, fieldName)
            {
                const arrayPrefixes = [];
                let prefix = fieldName;
                while(prefix.lastIndexOf(".[]") != -1)
                {
                    const index = prefix.lastIndexOf(".[]");
                    prefix = prefix.substr(0, index);
                    arrayPrefixes.push(prefix);
                }

                allKnownArrayPrefixes = arrayPrefixes.concat(allKnownArrayPrefixes);

                const fieldData = {
                    cardinality: uniqueValueHashes.size,
                    longest: longest[fieldName],
                    arrayPrefixes: arrayPrefixes
                };

                if (uniqueValueHashes.length > 0 && fieldData.longest > self[_options].longestIndexableValue)
                {
                    fieldData.mode = "hash";
                }
                else
                {
                    fieldData.mode = "normal";
                }

                fieldStatistics[fieldName.replace(/\.\[\]/g, "")] = fieldData;
            });

            self.collectionStatistics[collectionName] = new CollectionStatistics({
                fieldStatistics: fieldStatistics,
                knownArrayPrefixes: underscore.uniq(allKnownArrayPrefixes),
                lastSampleTime: new Date()
            });


            self.save(function(err)
            {
                if(err)
                {
                    return next(err);
                }

                return next(null, self.collectionStatistics[collectionName]);
            });
        });
    }



    /**
     * This method is used to determine statistical information about a set of indexes. This can help show if some of the fields on the index are unnesssary
     * because, on average, the index has already narrowed it down to 1 object by that point.
     *
     * NOTE! Currently ALL indexes in the IndexSet must be from the same collection!
     *
     * @param {IndexSet} indexSet The set of indexes to get statistics for
     * @param {function(err, [indexStatistics] )} next A callback which will receive a list of statistics objects
     */
    getIndexStatistics(indexSet, next)
    {
        const self = this;

        let indexesNeedingSample = [];
        let allResults = [];
        indexSet.indexes.forEach(function(index)
        {
            // See if we already have cardinality information for the requested collection
            if(self.indexStatistics[index.mongoCollectionName + "-" + index.mongoIndexName])
            {
                if (Math.abs(self.indexStatistics[index.mongoCollectionName + "-" + index.mongoIndexName].lastSampleTime.getTime() - Date.now()) < (self[_options].cardinalityUpdateInterval * 1000 * 60 * 60 * 24))
                {
                    allResults.push({
                        index: index,
                        statistics: self.indexStatistics[index.mongoCollectionName + "-" + index.mongoIndexName]
                    })
                }
                else
                {
                    indexesNeedingSample.push(index);
                }
            }
            else
            {
                indexesNeedingSample.push(index);
            }
        });

        // Don't even bother doing the sampler if its not needed
        if (indexesNeedingSample.length === 0)
        {
            return next(null, allResults);
        }

        // Get the distinct values for the field in question
        const collection = self.db.collection(indexesNeedingSample[0].mongoCollectionName);
        const numberOfObjectsToSample = self[_options].sampleSize;

        const prefixValueCount = {};
        let sampleFields = [];
        indexesNeedingSample.forEach(function(index)
        {
            prefixValueCount[index.mongoCollectionName + "-" + index.mongoIndexName] = {};

            const indexFields = Object.keys(index);
            for(let prefixLength = 1; prefixLength <= indexFields.length; prefixLength += 1)
            {
                const prefixFields = indexFields.slice(0, prefixLength);
                const prefixKey = JSON.stringify(prefixFields);
                prefixValueCount[index.mongoCollectionName + "-" + index.mongoIndexName][prefixKey] = {};
            }

            sampleFields = sampleFields.concat(Object.keys(index));
        });

        let totalSampled = 0;

        self.sampleCollection(numberOfObjectsToSample, {}, collection, underscore.uniq(sampleFields), function(object, next)
        {
            const flattened = flat(object);
            // Only compute unique values within the object. There could only be more then one
            // if the index contains an array
            const uniqueValues = {};

            Object.keys(flattened).forEach(function(flattenedKey)
            {
                // We make a version of the key that looks the way the variable would look if it were an index,
                // which is to just skip over arrays entirely
                let simplifiedKey = flattenedKey.replace(/\.\d+/g, "");

                if (!uniqueValues[simplifiedKey])
                {
                    uniqueValues[simplifiedKey] = new Set();
                }

                uniqueValues[simplifiedKey].add(flattened[flattenedKey]);
            });


            indexesNeedingSample.forEach(function(index)
            {
                const indexFields = Object.keys(index);

                // Now, for each possible prefix of the index, we compute all the unique values with that prefix
                // for this object
                for (let prefixLength = 1; prefixLength <= indexFields.length; prefixLength += 1)
                {
                    const prefixFields = indexFields.slice(0, prefixLength);

                    let objectKeys = [];
                    prefixFields.forEach(function (field)
                    {
                        if (objectKeys.length === 0)
                        {
                            if (uniqueValues[field])
                            {
                                uniqueValues[field].forEach(function (value)
                                {
                                    objectKeys.push({[field]: String(value).toString()})
                                });
                            }
                            else
                            {
                                objectKeys.push({[field]: String(null).toString()});
                            }

                        }
                        else
                        {
                            objectKeys = underscore.flatten(underscore.map(objectKeys, function (key)
                            {
                                let combinedObjectKeys = [];
                                if (uniqueValues[field])
                                {
                                    uniqueValues[field].forEach(function (value)
                                    {
                                        combinedObjectKeys.push(underscore.extend({}, key, {[field]: String(value).toString()}));
                                    });
                                }
                                else
                                {
                                    combinedObjectKeys.push(underscore.extend({}, key, {[field]: String(null).toString()}));
                                }
                                return combinedObjectKeys;
                            }));
                        }
                    });

                    const prefixKey = JSON.stringify(prefixFields);
                    objectKeys.forEach(function (key)
                    {
                        const keyString = farmhash.fingerprint32(JSON.stringify(key));
                        if (!prefixValueCount[index.mongoCollectionName + "-" + index.mongoIndexName][prefixKey][keyString])
                        {
                            prefixValueCount[index.mongoCollectionName + "-" + index.mongoIndexName][prefixKey][keyString] = 1;
                        }
                        else
                        {
                            prefixValueCount[index.mongoCollectionName + "-" + index.mongoIndexName][prefixKey][keyString] += 1;
                        }
                    });
                }
            });

            totalSampled += 1;

            return next();
        }, function(err)
        {
            if (err)
            {
                return next(err);
            }

            indexesNeedingSample.forEach(function(index)
            {
                const indexFields = Object.keys(index);

                // For each prefix of the index, we calculate the average number of distinct values for
                // each key
                const averageDistinctValues = {};
                for(let prefixLength = 1; prefixLength <= indexFields.length; prefixLength += 1)
                {
                    const prefixFields = indexFields.slice(0, prefixLength);
                    const prefixKey = JSON.stringify(prefixFields);

                    let total = 0;
                    Object.keys(prefixValueCount[index.mongoCollectionName + "-" + index.mongoIndexName][prefixKey]).forEach(function(key)
                    {
                        total += prefixValueCount[index.mongoCollectionName + "-" + index.mongoIndexName][prefixKey][key];
                    });

                    averageDistinctValues[indexFields[prefixLength - 1]] = total / Object.keys(prefixValueCount[index.mongoCollectionName + "-" + index.mongoIndexName][prefixKey]).length;
                }

                // Calculate the % reduction for each field
                let statistics = {};
                for(let prefixLength = 1; prefixLength <= indexFields.length; prefixLength += 1)
                {
                    let lastAverageDistinctValues = totalSampled;
                    if (prefixLength > 1)
                    {
                        lastAverageDistinctValues = averageDistinctValues[indexFields[prefixLength - 2]];
                    }

                    const currentAverageDistinctValues = averageDistinctValues[indexFields[prefixLength - 1]];
                    statistics[indexFields[prefixLength - 1]] = {
                        reduction: currentAverageDistinctValues / lastAverageDistinctValues,
                        currentAverageDistinct: currentAverageDistinctValues,
                        lastAverageDistinct: lastAverageDistinctValues
                    };
                }


                self.indexStatistics[index.mongoCollectionName + "-" + index.mongoIndexName] = new IndexStatistics({
                    fieldStatistics: statistics,
                    lastSampleTime: new Date()
                });

                allResults.push({
                    index: index,
                    statistics: self.indexStatistics[index.mongoCollectionName + "-" + index.mongoIndexName]
                });
            });
            

            self.save(function(err)
            {
                if(err)
                {
                    return next(err);
                }

                return next(null, allResults);
            });
        });
    }


    /**
     * This method is used to randomly sample a Mongo collection or a specific query within that collection.
     *
     * @param {number} count The number of objects to get from the collection. The sampler may return less then this, if there are fewer objects in the database that match the query.
     * @param {object} query The query to to sample the objects from. You can simply use {} to sample the entire collection
     * @param {object} collection A collection object from the Mongo NodeJS driver, obtained by db.getCollection(collectionName)
     * @param { [string] } select The list of fields to return in the result. Can be null to return all fields
     * @param {function(object, next)} iterator This function gets called with each object sampled from the database.
     * @param {function(err)} next A callback to be called after all the objects have been sampled.
     */
    sampleCollection(count, query, collection, select, iterator, next)
    {
        const self = this;
        // Start with the total number of objects within the collection
        collection.count(query, function(err, totalObjects)
        {
            if (err)
            {
                return next(err);
            }

            const timeBetweenSamples = (self[_options].sampleSpeed * 1000 / count);
            const numberOfObjectsToSample = Math.min(totalObjects, count);
            let randomObjectIndexes = {};
            let expectedTime = Date.now();

            if (numberOfObjectsToSample < count)
            {
                // We just sample everything
                for(let i = 0; i < numberOfObjectsToSample; i += 1)
                {
                    randomObjectIndexes[i] = true;
                }
            }
            else
            {
                // Generate a series of random indexes for objects within this collection that we will get
                for (let objectIndex = 0; objectIndex < numberOfObjectsToSample; objectIndex += 1)
                {
                    let found = false;
                    while (!found)
                    {
                        const index = Math.floor(Math.random() * totalObjects);
                        if (!randomObjectIndexes[index])
                        {
                            randomObjectIndexes[index] = true;
                            found = true;
                        }
                    }
                }
            }

            // Sort the list of random indexes
            randomObjectIndexes = underscore.sortBy(Object.keys(randomObjectIndexes), (index) => Number(index));

            if (self[_options].verbose)
            {
                console.log(`Randomly sampling ${select ? select.length : 'all'} fields from ${numberOfObjectsToSample} random objects from ${collection.namespace}`);
            }

            // Now we make a series of database requests, fetching the ids of the objects
            let processedObjects = 0;
            let currentQuery = underscore.extend({}, query);
            let lastIndex = 0;
            async.whilst(function()
                {
                    return processedObjects < numberOfObjectsToSample;
                },
                function(next)
                {
                    const index = randomObjectIndexes[processedObjects];

                    const cursor = collection.find(currentQuery).sort({_id: 1}).limit(1).skip(index - lastIndex);

                    if (select)
                    {
                        const projection = {};
                        select.forEach((field) => projection[field] = 1);
                        cursor.project(projection)
                    }

                    cursor.toArray(function(err, objects)
                    {
                        if (err)
                        {
                            return next(err);
                        }
                        else if (objects.length === 0)
                        {
                            // This means we exceeded the end of the collection, possibly because an object was deleted.
                            // Just skip this object
                            processedObjects += 1;
                            return next();
                        }
                        else
                        {
                            processedObjects += 1;
                            lastIndex = index;
                            if (query._id)
                            {
                                currentQuery = underscore.extend({}, query, {_id: underscore.extend({$gte: objects[0]._id}, query._id)});
                            }
                            else
                            {
                                currentQuery = underscore.extend({}, query, {_id: {$gte: objects[0]._id}});
                            }

                            if (self[_options].verbose)
                            {
                                if (processedObjects % 500 === 0)
                                {
                                    console.log(`    completed  ${processedObjects} / ${numberOfObjectsToSample}: ${(processedObjects * 100 / numberOfObjectsToSample).toFixed(2)}`);
                                }
                            }

                            expectedTime += timeBetweenSamples;
                            const sleepTime = Math.max(1, expectedTime - Date.now());
                            // Call the iterator with the converted object
                            setTimeout(function()
                            {
                                iterator(JSON.parse(JSON.stringify(objects[0])), next);
                            }, sleepTime);
                        }
                    });
                },
                function(err)
                {
                    if (err)
                    {
                        return next(err);
                    }

                    return next(null);
                });
        });
    }
}


module.exports = MongoSampler;
