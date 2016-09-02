"use strict";

const mongoFieldNamePartSeparator = "_____";

/**
 * This class stores statistical information about a collection, such as the cardinality of its fields
 */
class CollectionStatistics
{
    /**
     * Constructs a CollectionStatistics object from its serialized, pure JSON form
     *
     * @param {object} data The JSON object
     */
    constructor(data)
    {
        const self = this;
        self.fieldStatistics = {};
        Object.keys(data.fieldStatistics || {}).forEach(function(fieldName)
        {
            self.fieldStatistics[fieldName.replace(mongoFieldNamePartSeparator, ".")] = data.fieldStatistics[fieldName];
        });

        self.knownArrayPrefixes = data.knownArrayPrefixes;

        self.lastSampleTime = new Date(data.lastSampleTime);
    }


    /**
     * Converts the statistics into a JSON form that can be saved in the Mongo database.
     *
     * The main issue here is that Mongo does not like fields that contain ".", so instead we change these periods
     * to be five underscores, "_____"
     *
     * @returns {object} A JSON serializable form of this CollectionStatistics object.
     */
    toJSON()
    {
        const self = this;
        const newFieldStatistics = {};
        Object.keys(self.fieldStatistics).forEach(function(fieldName)
        {
            newFieldStatistics[fieldName.replace(/\./g, mongoFieldNamePartSeparator)] = self.fieldStatistics[fieldName];
        });


        // Convert every field with a period in it with something else before saving it to mongo
        return {
            fieldStatistics: newFieldStatistics,
            knownArrayPrefixes: self.knownArrayPrefixes,
            lastSampleTime: self.lastSampleTime.toISOString()
        }
    }
}

module.exports = CollectionStatistics;