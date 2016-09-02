"use strict";

const mongodb = require("mongodb"),
    MongoIndex = require("./mongo_index"),
    underscore = require("underscore");

const _naiveIndex = Symbol("_naiveIndex");
const _optimizedIndexes = Symbol("_optimizedIndexes");
const _reducedIndexes = Symbol("_reducedIndexes");
const _keyStatistics = Symbol("_keyStatistics");
const _options = Symbol("_options");

/**
 *  This class represents a query that has been broken down and analyzed.
 */
class QueryProfile
{
    /**
     * Constructs an QueryProfile object from a pure-JSON version of a query profile.
     *
     * The pure JSON object must look like the following:
     *
     * {
     *      namespace: "dbName.collectionName",
     *      exact: [String],
     *      sort: {String: direction},
     *      range: [String],
     *      lastQueryTime: "Date in ISO8601 format",
     *      sources: [
     *          {
     *              "source": "awesome_api_code.js:123",
     *              "version": "1.0.0"
     *          },
     *          {
     *              "source": "bad_queries.js:456",
     *              "version": "1.0.0"
     *          }
     *      ]
     * }
     *
     * @param {object} queryProfile A pure JSON object describing a query profile.
     * @param {object} options This is the global options object. The same object that is provided to optimizer.js
     */
    constructor(queryProfile, options)
    {
        this.namespace = queryProfile.namespace;
        this.exact = queryProfile.exact;
        this.sort = queryProfile.sort;
        this.range = queryProfile.range;
        if (!queryProfile.lastQueryTime)
        {
            this.lastQueryTime = new Date();
        }
        else
        {
            this.lastQueryTime = new Date(queryProfile.lastQueryTime);
        }

        if (!queryProfile.usageCount)
        {
            this.usageCount = 0;
        }
        else
        {
            this.usageCount = queryProfile.usageCount;
        }

        if (!queryProfile.sources)
        {
            this.sources = [];
        }
        else
        {
            this.sources = queryProfile.sources;
        }

        this[_options] = options;
    }

    /**
     * @returns {string} The database that this query was performed on
     */
    get databaseName()
    {
        return this.namespace.substr(0, this.namespace.indexOf("."));
    }

    /**
     * @returns {string} The collection that this query was performed on
     */
    get collectionName()
    {
        return this.namespace.substr(this.namespace.indexOf(".") + 1);
    }

    /**
     * @returns {string} A list of fields that are used in this query, for any purpose
     */
    get fields()
    {
        return underscore.uniq(this.exact.concat(Object.keys(this.sort).concat(this.range)));
    }

    /**
     * @returns {MongoIndex} Same as .naiveIndex. Returns the naiveIndex for this query.
     */
    get index()
    {
        const self = this;
        return self.naiveIndex;
    }


    /**
     * @returns {MongoIndex} Returns the naiveIndex for this query. The naive index is the index
     *                       would perfectly cover this query, before any optimizations have been
     *                       applied such as cardinality sorting or reduction with other indexes.
     */
    get naiveIndex()
    {
        const self = this;

        if (!self[_naiveIndex])
        {
            const index = {};

            this.exact.forEach(function(field)
            {
                index[field] = 1;
            });

            underscore.mapObject(this.sort, function(sort, field)
            {
                index[field] = sort;
            });

            this.range.forEach(function(field)
            {
                index[field] = 1;
            });

            self[_naiveIndex] = new MongoIndex(index, self.collectionName,  null);
        }

        return self[_naiveIndex];
    }

    /**
     * Note! This method must be called after QueryProfile.getCardinalitiesForIndexOptimization
     *
     * @returns { [MongoIndex] } Returns a list of MongoIndex objects, representing all of the optimized indexes required for
     *                           this query profile. This returns the same objects each time, but is lazy evaluated, so the
     *                           optimized indexes aren't generated until they are needed.
     */
    get optimizedIndexes()
    {
        const self = this;

        if (!self[_optimizedIndexes])
        {
            if(!self[_keyStatistics])
            {
                throw new Error("Unable to create index for query profile - don't have the key cardinalities");
            }

            // Now we adjust the exact match fields and range fields based on cardinality
            // Exact match has the largest cardinality first, range has the lowest first
            self.exact = underscore.sortBy(self.exact, (key) => -self[_keyStatistics][key].cardinality);
            self.range = underscore.sortBy(self.range, (key) => self[_keyStatistics][key].cardinality);

            // Start with the lists of fields
            let exact = self.exact;
            let sort = self.sort;
            let range = self.range;

            // Filter out fields that don't meet the minimum cardinality requirements,
            exact = underscore.filter(self.exact, (field) => self[_keyStatistics][field].cardinality >= self[_options].minimumCardinality);
            range = underscore.filter(self.range, (field) => self[_keyStatistics][field].cardinality >= self[_options].minimumCardinality);

            // Unless our cardinality filtering has led us to have no keys in our index, in that case, revert
            // to the original index
            if ((exact.length + Object.keys(sort).length + range.length) === 0)
            {
                exact = self.exact;
                range = self.range;
            }

            // Filter out fields that aren't able to be indexed because they are too large.
            // The index won't even get created if these fields are there
            const unIndexableFields = underscore.filter(self.fields, (field) => self[_keyStatistics][field].mode != 'normal');
            exact = underscore.filter(exact, (field) => unIndexableFields.indexOf(field) == -1);
            sort = underscore.object(underscore.filter(underscore.pairs(sort), (field) => unIndexableFields.indexOf(field[0]) == -1));
            range = underscore.filter(range, (field) => unIndexableFields.indexOf(field) == -1);

            // Now, lastly. Mongo is unable to have an index which contains multiple array values. Its an unfortunate pain in the ass,
            // because we have to create a different index for each array prefix there is.
            let arrayPrefixes = underscore.uniq(underscore.flatten(underscore.map(exact.concat(range.concat(Object.keys(sort))), function(fieldName)
            {
                return self[_keyStatistics][fieldName].arrayPrefixes;
            })));

            // If there is only one array index, then
            // we can ignore it safely
            if (arrayPrefixes.length < 2)
            {
                arrayPrefixes = [null];
            }

            self[_optimizedIndexes] = [];

            arrayPrefixes.forEach(function(arrayPrefix)
            {
                const index = {};

                let reducedExactFields = exact;
                let reducedSortFields = sort;
                let reducedRangeFields = range;
                if (arrayPrefix)
                {
                    reducedExactFields = underscore.filter(reducedExactFields, (field) => (self[_keyStatistics][field].arrayPrefixes.length == 0 || self[_keyStatistics][field].arrayPrefixes.indexOf(arrayPrefix) == -1));
                    reducedSortFields = underscore.filter(reducedSortFields, (field) => (self[_keyStatistics][field].arrayPrefixes.length == 0 || self[_keyStatistics][field].arrayPrefixes.indexOf(arrayPrefix) == -1));
                    reducedRangeFields = underscore.filter(reducedRangeFields, (field) => (self[_keyStatistics][field].arrayPrefixes.length == 0 || self[_keyStatistics][field].arrayPrefixes.indexOf(arrayPrefix) == -1));
                }

                reducedExactFields.forEach(function(field)
                {
                    index[field] = 1;
                });

                // Now we ensure that the first field being sorted on is always sorted positively,
                // and all other sort fields are adjusted to compensate. This is because mongo can
                // use an index as long as all the sort fields are sorted in the same direction
                // as the index, or the exact opposite. e.g. an index with {name: 1, email: 1}
                // can support sorts of {name: 1, email: 1} and {name: -1, email: -1} but not
                // {name: 1, email: -1} or {name: -1, email: 1}. Therefore, in order to ensure
                // the most reduction in indexes, we keep things consistent by always having
                // the first key sorted positively.
                const negateSorting = Object.keys(reducedSortFields).length > 0 ? reducedSortFields[Object.keys(reducedSortFields)[0]] : 1;
                underscore.mapObject(reducedSortFields, function(sort, field)
                {
                    index[field] = sort * negateSorting;
                });

                reducedRangeFields.forEach(function(field)
                {
                    index[field] = 1;
                });

                if(Object.keys(index).length > 0)
                {
                    self[_optimizedIndexes].push(new MongoIndex(index, self.collectionName, null));
                }
            });

            // If we have any unindexable fields, add in single field hash indexes for them. This can help make up some of the performance lost
            // because the field was unindexable in certain queries
            unIndexableFields.forEach(function(field)
            {
                self[_optimizedIndexes].push(new MongoIndex({[field]: 'hashed'}, self.collectionName, null))
            });
        }

        return self[_optimizedIndexes];
    }


    /**
     * Note! This method must be called after QueryProfile.getCardinalitiesForIndexOptimization
     *
     * @returns { [MongoIndex] } Returns the list of indexes that can be used for this query profile,
     *                           after reduction has been applied. It is important to note that this
     *                           list may actually be larger than the list in optimizedIndexes, as
     *                           multiple indexes may be able to cover this query profile after
     *                           reduction has been applied.
     */
    get reducedIndexes()
    {
        const self = this;
        if(self[_reducedIndexes])
        {
            return self[_reducedIndexes];
        }
        else
        {
            return self.optimizedIndexes;
        }
    }

    /**
     * This method is used to change the list of reduced indexes. It is used by MongoOptimizer::reduceIndexes
     *
     * @param { [MongoIndex] } reducedIndexes The list of indexes that can cover this query profile, after reduction has taken place.
     */
    set reducedIndexes(reducedIndexes)
    {
        const self = this;
        self[_reducedIndexes] = reducedIndexes;
    }
    
    get indexFieldStatistics()
    {
        const self = this;
        return self[_keyStatistics];
    }

    /**
     * Increments the usage count by 1
     */
    incrementUsageCount()
    {
        const self = this;
        return self.usageCount += 1;
    }

    /**
     * Adds a source to this query profile along with its version
     */
    addSource(source, version)
    {
        const self = this;
        if (!version)
        {
            version = "";
        }

        let existingSource = underscore.findWhere(self.sources, {source: source});
        if (existingSource)
        {
            existingSource.version = version;
        }
        else
        {
            self.sources.push({
                source: source,
                version: version
            });
        }
    }

    /**
     * @returns {string} A human readable representation of this QueryProfile object.
     */
    toString()
    {
        const self = this;

        function pad(str, n)
        {
            return str + new Array(Math.max(n - str.length, 0)).join(" ");
        }

        function formatField(field)
        {
            let str = field;
            self[_keyStatistics][field].arrayPrefixes.forEach(function(prefix)
            {
                str = str.replace(prefix, prefix + "[]")
            });
            return str;
        }

        const exactFields = underscore.map(this.exact, formatField).join(", ");
        const sortFields = underscore.map(underscore.pairs(this.sort), pair => formatField(pair[0]) + ":" + pair[1]).join(", ");
        const rangeFields = underscore.map(this.range, formatField).join(", ");

        return `QueryProfile(usage: ${pad(self.usageCount.toString(), 6)}   exact: ${pad(exactFields, 40)}    sort: ${pad(sortFields, 40)}    range: ${rangeFields})`;
    }


    /**
     * Returns a JSON representation of this QueryProfile object. This representation is suitable for storing in
     * a database, and can be used by the constructor to recreate a full QueryProfile object
     *
     * @returns {object} The JSON object
     */
    toJSON()
    {
        return {
            namespace: this.namespace,
            exact: this.exact,
            sort:  this.sort,
            range:  this.range,
            lastQueryTime: this.lastQueryTime.toISOString(),
            usageCount: this.usageCount,
            sources: this.sources
        }
    }


    /**
     * This method resets the list of optimized and reduced indexes so that they get recomputed.
     */
    resetIndexes()
    {
        const self = this;
        self[_reducedIndexes] = null;
        self[_optimizedIndexes] = null;
        self[_naiveIndex] = null;
        self[_keyStatistics] = null;
    }


    /**
     * Compares two query profile objects.
     *
     * @param {QueryProfile} otherQueryProfile
     * @returns {boolean} True if the two QueryProfile objects are the same (they represent the same query), false otherwise
     */
    isEquivalentToQueryProfile(otherQueryProfile)
    {
        const self = this;
        if (self.namespace != otherQueryProfile.namespace)
        {
            return false;
        }

        // Check to see if they have the same exact match fields.
        if (self.exact.length != otherQueryProfile.exact.length)
        {
            return false;
        }
        else if(underscore.difference(self.exact, otherQueryProfile.exact).length > 0)
        {
            return false;
        }

        // Next, check to see if they have the same sort fields with the same or reversible directions
        if (Object.keys(self.sort).length != Object.keys(otherQueryProfile.sort).length)
        {
            return false;
        }
        else if(underscore.difference(Object.keys(self.sort), Object.keys(otherQueryProfile.sort)).length > 0)
        {
            return false;
        }
        // Check to see if all the sort fields have the same direction
        else if(!underscore.every(Object.keys(self.sort), (sortKey) => (self.sort[sortKey] === otherQueryProfile.sort[sortKey])))
        {
            return false;
        }

        // Lastly, check to see if they have the same range fields
        if (self.range.length != otherQueryProfile.range.length)
        {
            return false;
        }
        else if(underscore.difference(self.range, otherQueryProfile.range).length > 0)
        {
            return false;
        }

        return true;
    }


    /**
     * This method gets field cardinality and statistical information for this QueryProfile object.
     *
     * This must be run before the list of optimizedIndexes can be computed.
     *
     * @param {MongoSampler} sampler A MongoSampler object connected to the database that can be used to get a list of random objects
     * @param {function(err)} next A callback after the cardinality information has been successfully obtained.
     */
    getCardinalitiesForIndexOptimization(sampler, next)
    {
        // Get the distinct values for the field in question
        const self = this;
        const collectionName = self.collectionName;
        const keysToCheck = self.exact.concat(self.range).concat(Object.keys(self.sort));
        self[_keyStatistics] = {};

        sampler.getCollectionStatistics(collectionName, function(err, collectionStatistics)
        {
            if (err)
            {
                return next(err);
            }

            keysToCheck.forEach(function(key)
            {
                if (!collectionStatistics.fieldStatistics[key])
                {
                    console.error("No statistical information found for field: ", key, ". You might be querying on a field that doesn't exist in your data!");
                    console.error("For the following query information:");
                    console.error(JSON.stringify(self, null, 2));
                    self[_keyStatistics][key] = {
                        mode: 'normal',
                        cardinality: self[_options].minimumCardinality,
                        longest: 1,
                        arrayPrefixes: underscore.filter(collectionStatistics.knownArrayPrefixes, (prefix) => (key.indexOf(prefix) == 0))
                    };
                }
                else
                {
                    self[_keyStatistics][key] = collectionStatistics.fieldStatistics[key];
                }
            });

            return next(null);
        });
    }

    /**
     * @returns {boolean} True if this QueryProfile involves only the _id field, false otherwise.
     */
    get isIDOnly()
    {
        const self = this;
        return self.fields.length == 1 && self.fields[0] == '_id';
    }

    /**
     * @returns {boolean} True if this query profile is empty, (no fields involved), false otherwise
     */
    get isEmpty()
    {
        const self = this;
        return self.fields.length == 0;
    }

    /**
     * This static function can be used to analyze mongos JSON profile objects and determine a list of indexes that were used.
     *
     * @param {object} mongoProfile A Mongo profile object from the system.profile collection
     * @returns { [MongoIndex] } A list of index objects with all the indexes being used in that profile
     */
    static getUsedIndexesInMongoProfile(mongoProfile)
    {
        let indexes = [];

        // Recurse through the execution stats until we find indexes
        function recurse(execStat)
        {
            if (execStat.children)
            {
                execStat.children.forEach(function(childExecStat)
                {
                    recurse(childExecStat);
                });
            }

            // If this is an index scan, lets take a look!
            if (execStat.type === 'IXSCAN')
            {
                // First we have to turn the key pattern into valid JSON
                let pattern = execStat.keyPattern;
                pattern = pattern.replace(/\s*\{\s*/g, "{\"");
                pattern = pattern.replace(/\s*:\s*/g, "\":");
                pattern = pattern.replace(/\s*,\s*/g, ",\"");
                pattern = pattern.replace(/\s*'\s*/g, "\"");

                let execStatIndex = JSON.parse(pattern);

                indexes.push(execStatIndex);
            }
        }

        if (!mongoProfile.execStats)
        {
            console.log("missing the exec stats");
            console.log(mongoProfile);
            return [];
        }
        else
        {
            recurse(mongoProfile.execStats);
        }

        const collectionName = mongoProfile.ns.substr(mongoProfile.ns.indexOf(".") + 1);
        return indexes.map((index) => new MongoIndex(index, collectionName));
    }

    /**
     * This method is used to look at a given mongo JSON profile object, and determine if the indexes we expected Mongo
     * to use for that query were the indexes it actually used.
     *
     * @param {object} mongoProfile A Mongo profile object from the system.profile collection
     * @returns {boolean} True if Mongo used at least one of the expected indexes, false otherwise.
     */
    didMongoProfileUseIndex(mongoProfile)
    {
        const self = this;

        let found = false;
        const indexes = QueryProfile.getUsedIndexesInMongoProfile(mongoProfile);

        indexes.forEach(function(actualIndex)
        {
            self.reducedIndexes.forEach(function(expectedIndex)
            {
                // See if the index used is the expected index for this query profile
                if (actualIndex.isSameAs(expectedIndex))
                {
                    found = true;
                }
                // We also allow if it the actual index is an index prefix of the expected index.
                // Although the optimizer would ordinarily reduce indexes which are prefixes of
                // other indexes, these indexes can exist anyhow if they were created by humans
                // or by the application, and thus aren't being managed by the mongo dynamic
                // indexer
                else if(actualIndex.isIndexPrefixOf(expectedIndex))
                {
                    found = true;
                }
            });
        });

        return found;
    }


    /**
     * This method is used to create a QueryProfile object from the given mongo filter and sort parameters.
     *
     * @param {string} namespace The database & collection that the query was performed on
     * @param {object} query An Mongo query object
     * @param {object} sort A Mongo sort object
     * @param {object} options The global script options object, the one that is passed to the MongoOptimizer object
     * @returns { [QueryProfile] } An array of QueryProfile objects for the query. Usually there is only one,
     *                             but in cases were there are $or's in the query, there will be more.
     */
    static createQueryProfilesFromMongoQuery(namespace, query, sort, options)
    {
        let allComments = [];

        function mergeQueryProfiles(one, two)
        {
            const profile = {
                exact: one.exact.concat(two.exact),
                sort: {},
                range: one.range.concat(two.range)
            };

            return profile;
        }

        function mergeSubQueries(currentSubQueries, newSubQueries)
        {
            let subQueries = [];

            currentSubQueries.forEach(function(subQuery)
            {
                newSubQueries.forEach(function(newSubQuery)
                {
                    subQueries.push(mergeQueryProfiles(subQuery, newSubQuery));
                });
            });

            return subQueries;
        }

        // This function trims periods on either end of a string
        function trimPeriods(str)
        {
            return str.replace(/^\./, "").replace(/\.$/, "");
        }

        // Analyze the query and break it down into exact match fields, sort fields, and range query fields
        function analyzeQuery(query, root)
        {
            let allSubQueries = [{
                exact: [],
                sort: {},
                range: []
            }];

            // First, go through the query for all exact match fields
            Object.keys(query).forEach(function(key)
            {
                const value = query[key];

                // This is not a special mongo field
                if(key[0] != '$')
                {
                    // Now look at the value, and decide what to do with it
                    if(value instanceof Date || value instanceof mongodb.ObjectID || value instanceof mongodb.DBRef)
                    {
                        allSubQueries.forEach(subQuery => subQuery.exact.push(trimPeriods(root + key)));
                    }
                    else if(value instanceof Object)
                    {
                        const subQueries = analyzeQuery(value, root + key);
                        allSubQueries = mergeSubQueries(allSubQueries, subQueries);
                    }
                    else
                    {
                        allSubQueries.forEach(subQuery => subQuery.exact.push(trimPeriods(root + key)));
                    }
                }
                else
                {
                    if(key == '$lt' || key == '$lte' || key == '$gt' || key == '$gte' || key == '$in' || key == '$nin' || key == '$neq' || key == '$ne' || key == '$exists' || key == '$mod' || key == '$all' || key == '$regex' || key == '$size')
                    {
                        allSubQueries.forEach(subQuery => subQuery.range.push(trimPeriods(root)));
                    }
                    else if(key == '$eq')
                    {
                        allSubQueries.forEach(subQuery => subQuery.exact.push(trimPeriods(root)));
                    }
                    else if(key == "$not")
                    {
                        const elemSubQueries = analyzeQuery(value, root);
                        allSubQueries = mergeSubQueries(allSubQueries, elemSubQueries);
                    }
                    else if(key == '$elemMatch')
                    {
                        // For $elemMatch, we have to create a subquery, and then modify its field names and merge
                        // it into our existing sub queries
                        const elemSubQueries = analyzeQuery(value, root + ".");
                        allSubQueries = mergeSubQueries(allSubQueries, elemSubQueries);
                    }
                    else if(key == '$options' || key == '$hint' || key == '$explain' || key == '$text')
                    {
                        // We can safely ignore these
                    }
                    else if(key == '$and' || key == '$or')
                    {
                        // Ignore these, they are processed after
                    }
                    else if(key == '$comment')
                    {
                        // Comments can be used by the application to provide additional metadata about the query
                        allComments.push(value);
                    }
                    else
                    {
                        console.error("Unrecognized field query command: ", key);
                    }
                }
            });

            // Now if there are $and conditions, process them
            if (query['$and'])
            {
                query['$and'].forEach(function(andSubQuery)
                {
                    allSubQueries = mergeSubQueries(allSubQueries, analyzeQuery(andSubQuery, root));
                });
            }

            // Lastly, process any $or conditions
            if (query['$or'])
            {
                allSubQueries = mergeSubQueries(allSubQueries, underscore.flatten(query['$or'].map(subQuery => analyzeQuery(subQuery, root))));
            }

            return allSubQueries;
        }

        const allProfiles = analyzeQuery(query, '');

        let source = "anonymous";
        let version = "";
        allComments.forEach(function (comment)
        {
            if(underscore.isObject(comment))
            {
                if(comment.source)
                {
                    source = comment.source;
                }

                if(comment.version)
                {
                    version = comment.version;
                }
            }
        });

        return allProfiles.map(function(queryProfile)
        {
            queryProfile.namespace = namespace;
            queryProfile.sort = sort;
            queryProfile.exact = underscore.uniq(queryProfile.exact);
            queryProfile.range = underscore.uniq(queryProfile.range);
            queryProfile.sources = [{source: source, version: version}];

            return new QueryProfile(queryProfile, options);
        });
    }


    /**
     * This method is used to analyze the query for a mongo JSON profile object, and create a list of QueryProfile objects
     * representing that query.
     *
     * @param {object} profile A Mongo profile object from the system.profile collection
     * @param {object} options The global script options object, the one that is passed to the MongoOptimizer object
     * @returns { [QueryProfile] } An array of QueryProfile objects for the query. Usually there is only one,
     *                             but in cases were there are $or's in the query, there will be more.
     */
    static createQueryProfilesFromMongoProfile(profile, options)
    {
        const namespace = profile.ns;
        let query;
        if(profile.query['$query'])
        {
            query = profile.query['$query'];
        }
        else if(profile.query['query'])
        {
            query = profile.query['query'];
        }
        else
        {
            query = profile.query;
        }

        let sort;
        if (profile.query['orderby'])
        {
            sort = profile.query['orderby'];
        }
        else
        {
            sort = {};
        }

        return QueryProfile.createQueryProfilesFromMongoQuery(namespace, query, sort, options)
    }
}




module.exports = QueryProfile;