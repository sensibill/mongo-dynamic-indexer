"use strict";

const crypto = require('crypto'),
    underscore = require("underscore");

const _indexName = Symbol("_indexName");
const _indexExists = Symbol("_indexExists");
const _indexStatistics = Symbol("_indexStatistics");
const _knownQueryProfiles = Symbol("_knownQueryProfiles");
const _collectionName = Symbol("_collectionName");

/**
 * This class represents an index in the mongo database. It is meant to be a loose wrapper around a pure
 * JSON index object.
 */
class MongoIndex
{
    /**
     * Creates a new MongoIndex object.
     *
     * @param {object} index A pure JSON index object, like {name: 1, email: -1}
     * @param {object} collectionName A string specifying the collection that this index is for
     * @param {string} [name] The name of the index. optional
     */
    constructor(index, collectionName, name)
    {
        const self = this;

        Object.keys(index).forEach(function(field)
        {
            self[field] = index[field];
        });

        if (!name)
        {
            self.generateIndexName();
        }
        else
        {
            self[_indexName] = name;
        }
        self[_knownQueryProfiles] = [];
        self[_indexExists] = false;
        self[_collectionName] = collectionName;
        self[_indexStatistics] = null;
    }


    /**
     * Sets the index name as a hash of the index itself
     */
    generateIndexName()
    {
        const self = this;
        const hash = crypto.createHash('sha256');
        hash.update(JSON.stringify(self));
        self[_indexName] = `auto_${hash.digest('hex')}`;
    }


    /**
     * Compares this index to another index and returns if they are the same.
     *
     * @param {MongoIndex} otherIndex Another index object
     * @returns {boolean} True if the indexes are the same, false otherwise
     */
    isSameAs(otherIndex)
    {
        const self = this;
        const keys = Object.keys(self);
        const otherKeys = Object.keys(otherIndex);
        if(keys.length != otherKeys.length)
        {
            return false;
        }

        for(let n = 0; n < keys.length; n += 1)
        {
            if (keys[n] != otherKeys[n])
            {
                return false;
            }
            else if (self[keys[n]] != otherIndex[otherKeys[n]])
            {
                return false;
            }
        }

        return true;
    }

    /**
     * Return true if this index is a prefix of the given index. It will return false
     * if is the same as the other index - an index is not the prefix of itself.
     *
     * @param {MongoIndex} otherIndex The other index object
     * @returns {boolean} true if this is a prefix of other, false otherwise
     */
    isIndexPrefixOf(otherIndex)
    {
        const self = this;
        const keys = Object.keys(self);
        const otherKeys = Object.keys(otherIndex);

        if(keys.length >= otherKeys.length)
        {
            return false;
        }

        for(let n = 0; n < keys.length; n += 1)
        {
            if (keys[n] != otherKeys[n])
            {
                return false;
            }
            else if (self[keys[n]] != otherIndex[otherKeys[n]])
            {
                return false;
            }
        }

        return true;
    }

    /**
     * Resets the list of known query profiles for this index
     */
    resetKnownQueryProfiles()
    {
        const self = this;
        self[_knownQueryProfiles] = [];
    }


    /**
     * Adds a QueryProfile as using this index as one of its reduced indexes.
     *
     * @param {QueryProfile} queryProfile A query profile object to add.
     */
    addKnownQueryProfile(queryProfile)
    {
        const self = this;
        self[_knownQueryProfiles].push(queryProfile);
    }

    /**
     * @returns {string} Returns the name of this index in the MongoDB.
     */
    get mongoIndexName()
    {
        const self = this;
        return self[_indexName];
    }

    /**
     * @returns {string} Returns the name of the collection this index is for
     */
    get mongoCollectionName()
    {
        const self = this;
        return self[_collectionName];
    }

    /**
     * @returns { [QueryProfile] } The list of query profiles that use this index as one of their reduced indexes
     */
    get knownQueryProfiles()
    {
        const self = this;
        return self[_knownQueryProfiles];
    }


    /**
     * @returns { String } A string representing this index
     */
    get canonicalString()
    {
        return JSON.stringify(this);
    }


    /**
     * @returns { Boolean } True if this index only uses _id, false otherwise
     */
    get isIDOnly()
    {
        const self = this;
        const fields = underscore.uniq(Object.keys(self));
        if (fields.length == 1 && fields[0] == '_id')
        {
            return true;
        }
        else
        {
            return false;
        }
    }

    /**
     * @returns { Boolean } True if this is an empty index (which is technically invalid), false otherwise
     */
    get isEmpty()
    {
        const self = this;
        if (Object.keys(self).length == 0)
        {
            return true;
        }
        else
        {
            return false;
        }
    }


    /**
     * @param {Boolean} value Sets whether this index is known to exist within Mongo (and thus doesn't need to be created).
     */
    setIndexExists(value)
    {
        this[_indexExists] = value;
    }


    /**
     * @returns { Boolean } True if this index is known to exist in the Mongo database already
     */
    doesIndexExist()
    {
        return this[_indexExists];
    }

    setIndexStatistics(statistics)
    {
        this[_indexStatistics] = statistics;
    }

    getIndexStatistics()
    {
        return this[_indexStatistics];
    }

    /**
     * This method can be used to conveniently remove a field from an index
     *
     * @param {string} field The field to remove from the index
     */
    removeField(field)
    {
        const self = this;
        delete self[field];

        // regenerate the index name
        self.generateIndexName();

        // Null out index statistics and set that we don't know whether the index exists
        self[_indexExists] = false;
        self[_indexStatistics] = null;
    }

    /**
     * This method can be used to conveniently add a field to an index=
     *
     * @param {string} field The field to add to the index
     */
    addField(field)
    {
        const self = this;
        self[field] = 1;

        // regenerate the index name
        self.generateIndexName();

        // Null out index statistics and set that we don't know whether the index exists
        self[_indexExists] = false;
        self[_indexStatistics] = null;
    }

    /**
     * This method will print this index, along with statistical information and associated query profiles, to the console.
     *
     * It will use the given indent
     *
     * @param {string} indent A string for the indentation that should go before each line of output
     * @param {boolean} printQueryProfiles A boolean as to whether we should print the query profiles associated with the index.
     */
    printIndexData(indent, printQueryProfiles)
    {
        const self = this;

        console.log(`${indent}MongoIndex(${JSON.stringify(self)}${self.doesIndexExist() ? "" : " (pending creation)"})        Used for ${self.knownQueryProfiles.length} query profile${self.knownQueryProfiles.length !== 1 ? 's' : ''}`);

        if(self.getIndexStatistics())
        {
            let string = `${indent}    stats: `;
            Object.keys(self.getIndexStatistics()).forEach(function(field)
            {
                const stats = self.getIndexStatistics();
                string += `${field}: ${stats[field].currentAverageDistinct.toFixed(2)}/${stats[field].lastAverageDistinct.toFixed(2)}=${(stats[field].reduction * 100).toFixed(2)}%;   `;
            });

            console.log(string);
        }

        if (printQueryProfiles)
        {
            let sortedKnownQueryProfiles = underscore.sortBy(self.knownQueryProfiles, (profile) => JSON.stringify(profile));
            sortedKnownQueryProfiles.forEach(function (queryProfile)
            {
                const indentedQueryProfile = queryProfile.toString().replace(/\n/g, `\n${indent}    `);
                console.log(`${indent}    ${indentedQueryProfile}`);

                const sources = underscore.sortBy(queryProfile.sources, (source) => source.source);
                if (!(sources.length == 1 && sources[0].source == 'anonymous'))
                {
                    sources.forEach(function (source)
                    {
                        let version = "";
                        if (source.version)
                        {
                            version = `${source.version} - `;
                        }

                        console.log(`${indent}        ${version}${source.source}`);
                    });
                }
            });
        }
    }
}

module.exports = MongoIndex;