"use strict";

const
    async = require('async'),
    QueryProfile = require('./query_profile'),
    IndexSet = require('./index_set'),
    underscore = require('underscore');

/**
 * QuerySet is a set of QueryProfile objects.
 */
class QuerySet
{
    /**
     * Create a new QuerySet object from the raw data
     *
     * @param { object } data The raw JSON data for this query set.
     * @param { object } sampler A MongoSampler object
     * @param { object } options The program wide options, like this passed to MongoOptimizer
     */
    constructor(data, sampler, options)
    {
        const self = this;

        if (!data)
        {
            data = {};
        }

        if (data.queryProfiles)
        {
            self.queryProfiles = underscore.map(data.queryProfiles, (queryData) => new QueryProfile(queryData, options));
        }
        else
        {
            self.queryProfiles = [];
        }

        self.options = options;
        self.sampler = sampler;
    }

    /**
     * Converts the QuerySet to json for serialization
     *
     * @returns {object} A JSON object representing the set of queries
     */
    toJSON()
    {
        // Convert every field with a period in it with something else before saving it to mongo
        return {
            queryProfiles: underscore.map(this.queryProfiles, function(queryProfile)
            {
                return queryProfile.toJSON();
            })
        }
    }

    /**
     * This method adds a given query profile to the query set if its not already there.
     *
     * If it is already there, it will update metadata like the last query time and
     * the sources for the query.
     *
     * @return { QueryProfile } Returns the existing query profile object if it exists, or the new QueryProfile object
     */

    addQueryProfile(queryProfile)
    {
        const self = this;

        // First, check to see if there is already a query profile that matches this one
        const existingQueryProfile = underscore.find(self.queryProfiles, (otherQueryProfile) => queryProfile.isEquivalentToQueryProfile(otherQueryProfile));
        if (!existingQueryProfile)
        {
            queryProfile.incrementUsageCount();

            self.queryProfiles.push(queryProfile);

            return queryProfile;
        }
        else
        {
            // Update the last query time for this profile
            existingQueryProfile.lastQueryTime = new Date();
            existingQueryProfile.incrementUsageCount();
            queryProfile.sources.forEach((source) => existingQueryProfile.addSource(source.source, source.version));

            return existingQueryProfile;
        }
    }


    /**
     *  This method filters the list of known query profiles for any that haven't been seen in a long time
     */
    removeOldQueryProfiles()
    {
        const self = this;

        if (self.options.recentQueriesOnlyDays != -1)
        {
            self.queryProfiles = underscore.filter(self.queryProfiles, function(profile)
            {
                return profile.lastQueryTime.getTime() > (Date.now() - self.options.recentQueriesOnlyDays * 24 * 60 * 60 * 1000)
            });
        }
    }

    /**
     * This method eliminates indexes which are just index-prefixes of other indexes. These indexes are superfluous
     * and can be eliminated with no performance penalty.
     *
     * This function also has the side effect of ensuring that all query-profile objects resolve to the *SAME* indexes
     * will then refer to the same MongoIndex in memory. This allows us to look in the opposite direction and determine
     * which query profiles are being used by a given index.
     */
    reduceIndexes(queryProfiles)
    {
        const self = this;

        // First, on each query profile, we make sure there aren't any duplicates in its current reducedIndexes set
        queryProfiles.forEach(function(queryProfile)
        {
            const indexes = queryProfile.reducedIndexes;

            let cont = true;
            while(cont)
            {
                cont = false;
                let found = false;
                for(let n = 0; n < indexes.length && !found; n += 1)
                {
                    for(let k = 0; k < indexes.length && !found; k += 1)
                    {
                        if (n !== k && indexes[n].isSameAs(indexes[k]))
                        {
                            // Just delete the second index
                            found = true;
                            indexes.splice(k, 1);
                        }
                    }
                }

                if (found)
                {
                    cont = true;
                }
            }

        });


        // Keep iterating until we reach a set point
        let changed = true;
        while(changed)
        {
            changed = false;

            // Now go through each index, and determine all of the indexes
            // which it is a prefix for. We set those as the reduced
            // reduced indexes. Simultaneously, we also
            queryProfiles.forEach(function(lhsQuery, lhsQueryN)
            {
                const lhsIndexes = lhsQuery.reducedIndexes;
                let newLHSIndexes = [];
                for(let lhsIndexPosition = 0; lhsIndexPosition < lhsIndexes.length; lhsIndexPosition += 1)
                {
                    const lhsIndex = lhsIndexes[lhsIndexPosition];
                    const lhsSameIndexes = [];
                    const lhsPrefixedIndexes = [];
                    queryProfiles.forEach(function (rhsQuery, rhsQueryN)
                    {
                        if (rhsQueryN != lhsQueryN && lhsQuery.collectionName === rhsQuery.collectionName)
                        {
                            const rhsIndexes = rhsQuery.reducedIndexes;
                            for (let rhsIndexPosition = 0; rhsIndexPosition < rhsIndexes.length; rhsIndexPosition += 1)
                            {
                                const rhsIndex = rhsIndexes[rhsIndexPosition];
                                if (lhsIndex.isSameAs(rhsIndex) && rhsQueryN > lhsQueryN)
                                {
                                    lhsSameIndexes.push(rhsIndex);
                                }
                                else if (lhsIndex.isIndexPrefixOf(rhsIndex))
                                {
                                    changed = true;
                                    lhsPrefixedIndexes.push(rhsIndex);
                                }
                            }
                        }
                    });

                    if(lhsPrefixedIndexes.length > 0)
                    {
                        newLHSIndexes = newLHSIndexes.concat(lhsPrefixedIndexes);
                    }
                    else if(lhsSameIndexes.length > 0)
                    {
                        newLHSIndexes = newLHSIndexes.concat(lhsSameIndexes);
                    }
                    else
                    {
                        newLHSIndexes = newLHSIndexes.concat([lhsIndex]);
                    }
                }

                newLHSIndexes = underscore.uniq(newLHSIndexes, false, (index) => JSON.stringify(index));
                lhsQuery.reducedIndexes = newLHSIndexes
            });
        }

        // Goes through every index, reset indexes known query profiles
        queryProfiles.forEach(function(queryProfile)
        {
            queryProfile.index.resetKnownQueryProfiles();
            queryProfile.optimizedIndexes.forEach((index) => index.resetKnownQueryProfiles());
            queryProfile.reducedIndexes.forEach((index) => index.resetKnownQueryProfiles());
        });

        // Now go through each profile, and make sure its index references it as a known query profile
        queryProfiles.forEach(function(queryProfile)
        {
            queryProfile.reducedIndexes.forEach((index) => index.addKnownQueryProfile(queryProfile));
        });
    }


    /**
     * This method computes the optimal IndexSet for this set of queries.
     *
     * @param {function(err)} callback The callback which will return with the optimal set of
     *                                 queries
     */
    computeOptimalIndexSet(callback)
    {
        const self = this;

        // Filter for only query profiles that meet the minimum usage count
        const queryProfiles = underscore.filter(self.queryProfiles, (queryProfile) => queryProfile.usageCount >= self.options.minimumQueryCount);

        // First, we go through all of our query profiles, and get them their cardinality and add their
        // indexes to the list
        async.eachSeries(queryProfiles, function (queryProfile, next)
        {
            queryProfile.resetIndexes();
            queryProfile.getCardinalitiesForIndexOptimization(self.sampler, function (err)
            {
                if (err)
                {
                    return next(err);
                }

                return next();
            });
        },
        function(err)
        {
            if (err)
            {
                return callback(err);
            }

            // Perform an index reduction, to eliminate unnecessary indexes
            self.reduceIndexes(queryProfiles);

            const groupedQueryProfiles = underscore.groupBy(queryProfiles, (queryProfile) => queryProfile.collectionName);

            // For each collection, we get the index statistics for that collections recommended indexes
            async.mapSeries(Object.keys(groupedQueryProfiles), function(collectionName, next)
            {
                const collectionQueryProfiles = groupedQueryProfiles[collectionName];

                let cont = true;
                async.whilst(function()
                {
                    return cont;
                }, function(next)
                {
                    // Get all of the reduced indexes for every query profile, flatten it and take out dupes
                    const collectionIndexes = underscore.uniq(underscore.flatten(underscore.map(collectionQueryProfiles, (queryProfile) => queryProfile.reducedIndexes)));
                    let indexSet = new IndexSet(collectionIndexes);

                    // Get the index statistics from the sampler
                    self.sampler.getIndexStatistics(indexSet, function(err, statistics)
                    {
                        if (err)
                        {
                            return next(err);
                        }

                        indexSet.indexes.forEach(function(index)
                        {
                            let stats = underscore.findWhere(statistics, {index: index});
                            index.setIndexStatistics(stats.statistics.fieldStatistics);
                        });

                        // Now, for each index, we eliminate the field with the lowest reduction rate.
                        // If the index has no fields that reduce less then 50%, then we do nothing
                        // If there are multiple fields with the same lowest reduction rate,
                        // we eliminate the right most field
                        cont = false;

                        if (self.options.verbose)
                        {
                            console.log("Statistics obtained, starting simplification pass:");
                        }

                        indexSet.indexes.forEach(function(index)
                        {
                            if (self.options.verbose)
                            {
                                index.printIndexData("    ", false);
                            }

                            // If there is only one field in the index, don't do anything. Do not eliminate this last field
                            if (Object.keys(index).length === 1)
                            {
                                return;
                            }

                            // Get all of the known sort fields for the query profiles on this
                            // index. Sort fields can not be eliminated
                            const sortFields = underscore.uniq(underscore.flatten(underscore.map(index.knownQueryProfiles, (queryProfile) => Object.keys(queryProfile.sort))));

                            // Create a list of fields to examine
                            const fieldsToExamine = underscore.difference(Object.keys(index), sortFields);

                            // First determine if we do anything at all.
                            let possibleFieldsToEliminate = 0;

                            fieldsToExamine.forEach(function(field)
                            {
                                const fieldStats = index.getIndexStatistics()[field];
                                if (fieldStats.reduction > self.options.minimumReduction)
                                {
                                    possibleFieldsToEliminate += 1;
                                }
                            });

                            // If there are no fields to eliminate, then we return the index as-is
                            if (possibleFieldsToEliminate === 0)
                            {
                                return;
                            }

                            // Otherwise, lets choose which field to eliminate
                            // First, lets see what the lowest amount of reduction
                            let reductionValue = index.getIndexStatistics()[underscore.max(fieldsToExamine, function(field)
                            {
                                return index.getIndexStatistics()[field].reduction;
                            })];

                            // Now go through the list of fields and determine the
                            // last field which has this exact value
                            let fieldToEliminate = null;
                            fieldsToExamine.forEach(function(field)
                            {
                                if (index.getIndexStatistics()[field] === reductionValue)
                                {
                                    cont = true;
                                    fieldToEliminate = field
                                }
                            });

                            // Remove this field from the index
                            if (fieldToEliminate)
                            {
                                if (self.options.verbose)
                                {
                                    console.log(`    Removing field ${fieldToEliminate}`);
                                }
                                index.removeField(fieldToEliminate);
                            }
                        });

                        // Now after we have removed all those fields from all those indexes, we do another index reduction
                        self.reduceIndexes(queryProfiles);

                        return next(null);
                    });
                },
                function (err)
                {
                    if (err)
                    {
                        return next(err);
                    }

                    return next(null);
                });
            }, function (err)
            {
                if (err)
                {
                    return callback(err);
                }

                // Combine all of the index sets together
                const allIndexes = underscore.uniq(underscore.flatten(underscore.map(queryProfiles, (queryProfile) => queryProfile.reducedIndexes)));

                if (self.options.indexExtension)
                {
                    // Now, finally, we get to the real meaty part - index extension! This is where we go back
                    // over the indexes that we have previously pruned and recombined, and see if there are any
                    // fields that we can add to the index to make it more specific
                    allIndexes.forEach(function (index)
                    {
                        let cont = true;
                        let indexQueryProfiles = index.knownQueryProfiles;
                        while (cont)
                        {
                            cont = false;

                            // Keep track of votes for each extension field
                            const extensionFieldVotes = {};
                            const extensionFieldQueryProfiles = {};

                            // Now look at each query profile associated with that index
                            indexQueryProfiles.forEach(function (queryProfile)
                            {
                                // Determine which fields from this query profile are eligible
                                // Start with only exact match and range fields which aren't
                                // already in the index
                                let eligibleExtensionFields = underscore.filter(queryProfile.exact.concat(queryProfile.range), (field) => Object.keys(index).indexOf(field) == -1);

                                // Now we look at the field statistics to see if these fields are even able to be included -
                                // no hashed or array fields
                                eligibleExtensionFields = underscore.filter(eligibleExtensionFields, function (field)
                                {
                                    const statistics = queryProfile.indexFieldStatistics[field];
                                    if (statistics.arrayPrefixes.length > 0)
                                    {
                                        return false;
                                    }

                                    if (statistics.mode === 'hash')
                                    {
                                        return false;
                                    }

                                    return true;
                                });

                                eligibleExtensionFields.forEach(function (field)
                                {
                                    // Now for each eligible extension field, we increase the votes
                                    if (!extensionFieldVotes[field])
                                    {
                                        extensionFieldVotes[field] = queryProfile.usageCount;
                                        extensionFieldQueryProfiles[field] = [queryProfile];
                                    }
                                    else
                                    {
                                        extensionFieldVotes[field] += queryProfile.usageCount;
                                        extensionFieldQueryProfiles[field].push(queryProfile);
                                    }
                                });
                            });

                            if (Object.keys(extensionFieldVotes).length === 0)
                            {
                                cont = false;
                            }
                            else
                            {
                                // Now we take the extension field which has the most votes
                                let fieldToAdd = underscore.max(Object.keys(extensionFieldVotes), (field) => extensionFieldVotes[field]);
                                if (fieldToAdd)
                                {
                                    index.addField(fieldToAdd);
                                    indexQueryProfiles = extensionFieldQueryProfiles[fieldToAdd];
                                    cont = true;
                                }
                                else
                                {
                                    cont = false;
                                }
                            }
                        }
                    });
                }

                const groupedQueryProfiles = underscore.groupBy(queryProfiles, (queryProfile) => queryProfile.collectionName);

                // For each collection, we get the index statistics for that collections recommended indexes
                async.eachSeries(Object.keys(groupedQueryProfiles), function(collectionName, next)
                {
                    const collectionQueryProfiles = groupedQueryProfiles[collectionName];

                    // Get all of the reduced indexes for every query profile, flatten it and take out dupes
                    const collectionIndexes = underscore.uniq(underscore.flatten(underscore.map(collectionQueryProfiles, (queryProfile) => queryProfile.reducedIndexes)));
                    let indexSet = new IndexSet(collectionIndexes);

                    // Get the index statistics from the sampler
                    self.sampler.getIndexStatistics(indexSet, function (err, statistics)
                    {
                        if (err)
                        {
                            return next(err);
                        }
                        else
                        {
                            indexSet.indexes.forEach(function (index)
                            {
                                let stats = underscore.findWhere(statistics, {index: index});
                                index.setIndexStatistics(stats.statistics.fieldStatistics);
                            });

                            return next();
                        }
                    });
                }, function(err)
                {
                    if (err)
                    {
                        return callback(err);
                    }


                    // Create a new index set
                    const allIndexSet = new IndexSet(allIndexes);

                    // Return an index set with all of the indexes
                    return callback(null, allIndexSet);
                });
            });
        });
    }
}

module.exports = QuerySet;
