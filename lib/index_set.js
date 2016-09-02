"use strict";

const underscore = require('underscore');

/**
 * IndexSet is exactly what it sounds like - its a set of indexes.
 */
class IndexSet
{
    /**
     * Create a new IndexSet object from a given set of indexes
     *
     * @param { [MongoIndex] } indexes The list of indexes for this set.
     */
    constructor(indexes)
    {
        const self = this;
        self.indexes = indexes;
    }


    /**
     * This method prints all the indexes in this index set to the console.
     */
    print()
    {
        const self = this;
        let strings = self.indexes.map(function(index)
        {
            return (`${index.mongoCollectionName}(${JSON.stringify(index)}, {name: "${index.mongoIndexName}"});`);
        });

        strings = underscore.sortBy(strings, (s) => s);

        console.log(strings.join('\n'));
    }


    /**
     * This method will go through the reduced set of indexes for our query profiles, and
     * compare them to the set of indexes that we have in the database. It will then, for
     * each collection, produce its recommended index plan. This includes which indexes to
     * drop, which to keep, and which to create new.
     *
     * @param { IndexSet } recommendedIndexSet This is the set of indexes which are
     * @param { IndexSet } currentIndexSet This is the set of indexes
     *
     * @returns {object} An object containing the recommended changes to be made
     */
    static getRecommendedIndexChanges(recommendedIndexSet, currentIndexSet)
    {
        // Find all the collections for these indexes
        const allCollections = underscore.uniq(underscore.flatten([
            underscore.map(recommendedIndexSet.indexes, (index) => index.mongoCollectionName),
            underscore.map(currentIndexSet.indexes, (index) => index.mongoCollectionName)
        ]));

        // We sort indexes into three groups - create, drop, and keep, for each collection
        const groupedRecommendedIndexes = underscore.groupBy(recommendedIndexSet.indexes, (index) => index.mongoCollectionName);
        const groupedCurrentIndexes = underscore.groupBy(currentIndexSet.indexes, (index) => index.mongoCollectionName);

        return underscore.map(allCollections, function(collectionName)
        {
            const existingIndexes = groupedCurrentIndexes[collectionName] || [];
            const wantedIndexes = groupedRecommendedIndexes[collectionName] || [];

            const existingIndexesByCanonicalString = underscore.groupBy(existingIndexes, index => index.canonicalString);
            const wantedIndexesByCanonicalString = underscore.groupBy(wantedIndexes, index => index.canonicalString);

            const existingIndexCanonicalStrings = underscore.sortBy(Object.keys(existingIndexesByCanonicalString), (indexString) => indexString);
            const wantedIndexCanonicalStrings = underscore.sortBy(Object.keys(wantedIndexesByCanonicalString), (indexString) => indexString);

            // See the list of wanted indexes that we don't have
            const indexesToCreate = underscore.difference(wantedIndexCanonicalStrings, existingIndexCanonicalStrings);
            let indexesToDrop = underscore.difference(existingIndexCanonicalStrings, wantedIndexCanonicalStrings);
            let indexesToKeep = underscore.intersection(existingIndexCanonicalStrings, wantedIndexCanonicalStrings);

            indexesToKeep = indexesToKeep.concat(underscore.filter(indexesToDrop, indexString => existingIndexesByCanonicalString[indexString][0].mongoIndexName.indexOf('auto_') != 0));
            indexesToDrop = underscore.filter(indexesToDrop, indexString => existingIndexesByCanonicalString[indexString][0].mongoIndexName.indexOf('auto_') == 0);

            // Just for convenience sake, go through all of the indexes to keep and mark them as existing.
            indexesToKeep.forEach((indexString) => (wantedIndexesByCanonicalString[indexString] || existingIndexesByCanonicalString[indexString])[0].setIndexExists(true));

            return {
                collectionName: collectionName,
                create: underscore.map(indexesToCreate, (indexString) => wantedIndexesByCanonicalString[indexString][0]),
                drop: underscore.map(indexesToDrop, (indexString) => existingIndexesByCanonicalString[indexString][0]),
                keep: underscore.map(indexesToKeep, (indexString) => (wantedIndexesByCanonicalString[indexString] || existingIndexesByCanonicalString[indexString])[0]),
            };
        });
    }
}

module.exports = IndexSet;