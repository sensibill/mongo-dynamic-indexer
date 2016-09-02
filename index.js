#!/usr/bin/env node

"use strict";

const commander = require("commander"),
    consoleLogMod = require("./lib/console_log_mod"),
    MongoOptimizer = require("./lib/optimizer"),
    underscore = require('underscore');




function main()
{
    // add logging for event 'uncaughtException'. Emitted when an exception bubbles all the way back to the event loop.
    // See: http://nodejs.org/api/process.html#process_event_uncaughtexception
    process.on('uncaughtException', function (err)
    {
        console.error('Uncaught Exception:', err.stack);
        process.exit(255);
    });

    const packageData = require("./package.json");
    commander
        .version(packageData.version)
        .option('-d, --database <database>', 'The URI of the Mongo database which we will connect to. Must include the username and password.')
        .option('-s, --sample-size <sample-size>', 'The maximum number of documents to sample from a collection to determine cardinality information about fields on that collection, or indexes being proposed for that collection. Default is 100,000. Its highly recommended to keep this large.')
        .option('--sample-speed <sample-speed>', 'This is the number of seconds over which to sample a given collection. This is done so that we don\'t blast a database a ton of queries in a very short period of time. A lower number means faster speed. Default 10 minutes.')
        .option('--minimum-cardinality <minimum-cardinality>', 'The minimum number of distinct values a field should have in order to be included in an index. Default is 3. Set to 1 to disable this and include all fields.')
        .option('--minimum-reduction <minimum-reduction>', 'This is the amount that a field should narrow down results by in order to be considered worth having on the index. Default is 0.70, meaning that a field should, on average, remove at least 30% of the possible results to be considered worth having on the index. Setting this to 1 will disable the functionality. Please see the documentation for a better explanation of this functionality.')
        .option('--no-index-extension', 'This disables the index extension optimization.')
        .option('-c, --do-changes', 'This tells the dynamic indexer that it should actually make the changes to the database that it recommends.')
        .option('--collection <collection>', 'This is the collection which the dynamic indexer should use to store information on query patterns')
        .option('-i, --interval <interval>', 'How often, in seconds, should the dynamic indexer make its recommendations')
        .option('--cardinality-update-interval <cardinality-update-interval>', 'This is the number of days that cardinality information is valid for. Default 30 days.')
        .option('--show-changes-only', 'If this is enabled, the script will only show the changes its making when synchronization, rather then a complete summary of all indexes.')
        .option('-p, --profile-level <profile-level>', 'This is the profiling level to set the database to. This is the same as Mongos profiling level, see https://docs.mongodb.com/manual/reference/command/profile/#dbcmd.profile. The default is 2, full profiling, but using 1 will enable slow-query-mode. If you set this to -1, the profiling level will not be changed from what it currently is.')
        .option('-r, --recent-queries-only-days <recent-queries-only-days>', 'This is the number of days after seeing a query to forget about it. This ensures that queries that your code no longer peforms don\'t leave indexes around that you no longer need. By default this is set to -1, which means its disabled, meaning that old indexes will not get deleted unless you refresh the state of the dynamic indexer.')
        .option('-m, --minimum-query-count <minimum-query-count>', 'This is the minimum number of times that a particular query needs to have happened before the dynamic indexer will create an index for it. Defaults to 1, which will create an index for any query.')
        .option('--verbose', 'Enable verbose output. Defaults to false. Can be helpful when trying to determine precisely why the system recommended the indexes that it did')
        .option('--debug', 'Enable debug mode. Debug mode will include line numbers with all the output')
        .option('--simple', 'Enable simple output mode. Instead of outputting a complete description of the index plan, it will instead just output the indexes raw. Easier for copying and pasting into your own code.')
        .parse(process.argv);

    let options = {
        database: commander['database'],
        sampleSize: commander['sampleSize'],
        sampleSpeed: commander['sampleSpeed'],
        minimumCardinality: commander['minimumCardinality'],
        minimumReduction: commander['minimumReduction'],
        indexExtension: commander['indexExtension'],
        doChanges: commander['doChanges'],
        collection: commander['collection'],
        indexSynchronizationInterval: commander['interval'],
        cardinalityUpdateInterval: commander['cardinalityUpdateInterval'],
        showChangesOnly: commander['showChangesOnly'],
        profileLevel: commander['profileLevel'],
        recentQueriesOnlyDays: commander['recentQueriesOnlyDays'],
        minimumQueryCount: commander['minimumQueryCount'],
        verbose: commander['verbose'],
        debug: commander['debug'],
        simple: commander['simple']
    };

    let defaults = {
        database: "mongodb://localhost:27017/test",
        sampleSize: 100000,
        sampleSpeed: 60 * 10,
        minimumCardinality: 3,
        minimumReduction: 0.7,
        indexExtension: true,
        longestIndexableValue: 500,
        doChanges: false,
        collection: "index-optimizer",
        indexSynchronizationInterval: 60,
        cardinalityUpdateInterval: 30,
        showChangesOnly: false,
        profileLevel: 2,
        recentQueriesOnlyDays: -1,
        minimumQueryCount: 1,
        verbose: false,
        debug: false,
        simple: false
    };

    options = underscore.defaults(options, defaults);

    if (options.debug)
    {
        consoleLogMod.apply();
    }

    const optimizer = new MongoOptimizer(options);
    optimizer.connect(function(err)
    {
        if (err)
        {
            console.error(err);
            process.exit(1);
        }

        optimizer.loadOptimizerData(function(err)
        {
            if (err)
            {
                console.error(err);
                process.exit(1);
            }

            optimizer.startOptimizer(function(err)
            {
                if (err)
                {
                    console.error(err);
                    process.exit(1);
                }

                console.log("Mongo Dynamic Indexer has been started!");
            });
        });
    });
}



main();
