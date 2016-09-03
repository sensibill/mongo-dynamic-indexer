# IMPORTANT NOTE

This repository is a downstream clone of https://bitbucket.org/sensibill/mongo-dynamic-indexer. Its been put to make the tool
more visible among the git community. For the latest code, please follow that link!

# Table of Contents

- [Introduction](#introduction)
- [License](#license)
- [Quick Start](#quick-start)
- [Command line Arguments](#command-line-arguments)
- [Comparison with other tools](#comparison-with-other-tools)
- [Fine Tuning Results](#fine-tuning-results)
- [Modes of Usage](#modes-of-usage)
    - [Static Analysis](#static-analysis)
    - [Dynamic Service - Mongo Slow Query Profiling Mode](#dynamic-service---mongo-slow-query-profiling-mode)
    - [Dynamic Service - Mongo full profiling mode with only recent query profiles](#dynamic-service---mongo-full-profiling-mode-with-only-recent-query-profiles)
    - [As a library (under construction)](#as-a-library-under-construction)
- [Query Metadata](#query-metadata)
- [How does it pick indexes?](#how-does-it-pick-indexes)
    - [Step 1: Collect and break down the queries](#step-1-collect-and-break-down-the-queries)
    - [Step 2: Randomly sample the collection to statistics for each field](#step-2-randomly-sample-the-collection-to-statistics-for-each-field)
    - [Step 3: Compute the optimal index for each query profile](#step-3-compute-the-optimal-index-for-each-query-profile)
    - [Step 4: Eliminate indexes which are prefixes of other indexes](#step-4-eliminate-indexes-which-are-prefixes-of-other-indexes)
    - [Step 5: Randomly sample the collection for index statistics and eliminate unnecessary fields](#step-5-randomly-sample-the-collection-for-index-statistics-and-eliminate-unnecessary-fields)
    - [Step 6: Index Extension](#step-6-index-extension)
- [Troubleshooting](#troubleshooting)
- [TODO](#todo)

# Introduction

The Mongo Dynamic Indexer is a tool for automatically picking and maintaining indexes 
based on the real queries being made to the database.

It is similar to the tool Dex, https://github.com/mongolab/dex, created by MongoLab.
The difference is that Dex was merely a tool to recommend indexes that you would later
hand tune and modify with your own knowledge of your data.

Mongo Dynamic Indexer, on the other hand, is meant to be full service. It automatically
takes random samples of your data in order to help it determine the cardinality information
for each field, and for combinations of fields used to make up indexes. This allows
Mongo Dynamic Indexer to do a whole host of optimizations that other tools don't attempt,
and the resulting indexes are just fantastic. They are minimalistic but still totally
cover your queries.

# License

Mongo Dynamic Indexer is licensed under MIT license. Please see the license file within
the distribution.

# Quick Start

## Install through NPM

Installation is quick and easy through npm.

    $ npm install mongo-dynamic-indexer -g

## Start the dynamic indexer

Start the indexer pointing to your database. Note that, by default, it will enable profiling
on your database, so you must have that permission on the user you log in with.

    $ mongodynamicindexer -d mongodb://localhost:27017/your_database -c -p 2

You could also just enable profiling manually, and use -p -1 so that the dynamic indexer will not change the profiling level:

    $ mongo
    MongoDB shell version: 2.6.10
    connecting to: test
    > db.setProfilingLevel(2)
    { "was" : 0, "slowms" : 100, "ok" : 1 }
    >

## Use your system as you normally would

Now you just use your system as you normally would! As queries come in, the Mongo Dynamic
Indexer will record them. Every 60 seconds (change with -i), it will print out its recommended
indexes and will make the changes (-c enables making the changes live).


# Command line Arguments

    $ mongodynamicindexer --help

    Usage: mongodynamicindexer [options]
    
    Options:

    -h, --help                                                   output usage information
    -V, --version                                                output the version number
    -d, --database <database>                                    The URI of the Mongo database which we will connect to. Must include the username and password.
    -s, --sample-size <sample-size>                              The maximum number of documents to sample from a collection to determine cardinality information about fields on that collection, or indexes being proposed for that collection. Default is 100,000. Its highly recommended to keep this large.
    --sample-speed <sample-speed>                                This is the number of seconds over which to sample a given collection. This is done so that we dont blast a database a ton of queries in a very short period of time. A lower number means faster speed. Default 10 minutes.
    --minimum-cardinality <minimum-cardinality>                  The minimum number of distinct values a field should have in order to be included in an index. Default is 3. Set to 1 to disable this and include all fields.
    --minimum-reduction <minimum-reduction>                      This is the amount that a field should narrow down results by in order to be considered worth having on the index. Default is 0.70, meaning that a field should, on average, remove at least 30% of the possible results to be considered worth having on the index. Setting this to 1 will disable the functionality. Please see the documentation for a better explanation of this functionality.
    --no-index-extension <no-index-extension>                    This disables the index extension optimization.
    -c, --do-changes                                             This tells the dynamic indexer that it should actually make the changes to the database that it recommends.
    --collection <collection>                                    This is the collection which the dynamic indexer should use to store information on query patterns
    -i, --interval <interval>                                    How often, in seconds, should the dynamic indexer make its recommendations
    --cardinality-update-interval <cardinality-update-interval>  This is the number of days that cardinality information is valid for. Default 30 days.
    --show-changes-only                                          If this is enabled, the script will only show the changes its making when synchronization, rather then a complete summary of all indexes.
    -p, --profile-level <profile-level>                          This is the profiling level to set the database to. This is the same as Mongos profiling level, see https://docs.mongodb.com/manual/reference/command/profile/#dbcmd.profile. The default is 2, full profiling, but using 1 will enable slow-query-mode. If you set this to -1, the profiling level will not be changed from what it currently is.
    -r, --recent-queries-only-days <recent-queries-only-days>    This is the number of days after seeing a query to forget about it. This ensures that queries that your code no longer peforms dont leave indexes around that you no longer need. By default this is set to -1, which means its disabled, meaning that old indexes will not get deleted unless you refresh the state of the dynamic indexer.
    -m, --minimum-query-count <minimum-query-count>              This is the minimum number of times that a particular query needs to have happened before the dynamic indexer will create an index for it. Defaults to 1, which will create an index for any query.
    --verbose                                                    Enable verbose output. Defaults to false. Can be helpful when trying to determine precisely why the system recommended the indexes that it did
    --debug                                                      Enable debug mode. Debug mode will include line numbers with all the output
    --simple                                                     Enable simple output mode. Instead of outputting a complete description of the index plan, it will instead just output the indexes raw. Easier for copying and pasting into your own code.


# Comparison with other tools

Mongo Dynamic Indexer is far from the first tool to automatically recommend indexes for Mongo. However, it is the very first to do a whole host
of optimizations that other tools don't do. See the comparison of the optimizations performed, and you will know that Mongo Dynamic Indexer
will produce excellent indexes for you!

## Dex

- Breaks apart queries into exact match, sort, and range portions
- Automatically handles $or, $and, and $elemMatch conditions

## Mongo Dynamic Indexer

- Breaks apart queries into exact match, sort, and range portions
- Automatically handles $or, $and, and $elemMatch conditions
- Automatically sorts the exact-match and range fields by their cardinality. Highest cardinality first for exact match fields, lowest cardinality first for range fields.
- Automatically handles parallel arrays by creating two separate indexes (Mongo does not support creating an index that has two separate array fields), see https://docs.mongodb.com/manual/core/index-multikey/#limitations
- Automatically moves unindexable fields (due to length) into a separate "hashed" indexes
- Allows you to automatically eliminate low-cardinality fields, such as booleans, from the resulting indexes
- Automatically eliminates fields from indexes that don't add any additional specificity (by default, each additional field should narrow down results by at least 30%, most rules of thumb suggest 90% here). This particular optimization requires many passes of random sampling over your data, but its worth it!
- Correctly handles multi-sort fields with different directions (sort {a:1, b:-1} can't use the index {a:1,b:1}, it must have {a:1,b:-1})
- Automatically eliminates indexes which are just prefixes of other indexes (if you have {a: 1} and {a:1, b:1}, the first {a:1} index is totally superfluous)
- Does multiple passes over the above algorithms to further ensure the most minimalistic effective set of indexes.
- Allows you to filter out one-off queries that haven't occurred very often
- Allows you to provide metadata about your query using $comment, so you can see exactly where in your code a particular index is coming from!

As you can see, Mongo Dynamic Indexer, while slower and requiring random sampling of your data, can produce way, way better results!

# Fine Tuning Results

The main way to fine tune results is through the `--minimum-cardinality` and `--minimum-reduction` options.

## If you want fewer resulting indexes, and more sharing of indexes between queries

- Increase `--minimum-cardinality` so that low cardinality fields, like "status" or other enumerations, are eliminated from the base of the indexes. The default of `--minimum-cardinality 3` only eliminates boolean fields, since boolean fields have only 2 possible values. Raising it to `--minimum-cardinality 10` would eliminate more small enumerations and other fields with only a handful of values. Remember these fields are not deleted entirely from the indexes - they can be added back on in Step 6 of the optimization algorithm. Its simply that the system won't consider these fields when trying to see which queries can share indexes in Steps 4 and 5.
- Decrease `--minimum-reduction` to eliminate fields that don't add much specificity to the index (often because they are highly correlated with other fields in the index). The default value of `--minimum-reduction 0.7` will only eliminate fields that, on average, narrow down the results less then 30%. Some blogs (such as https://emptysqua.re/blog/optimizing-mongodb-compound-indexes/#equality-range-sort ) suggest a rule of thumb of eliminating all fields that don't narrow results at least 90%. This would imply a value of `--minimum-reduction 0.1`. Remember that if you decrease this value, it would require more rounds of random sampling your data in order to determine the statistics. Be sure to adjust `--sample-speed` as needed.

## If you want fewer indexes, eliminating indexes for queries that don't happen very often

- Increase `--minimum-query-count` so that rare queries are filtered out and don't result in indexes

## If you want more indexes that are more specific to their queries

- Decrease `--minimum-cardinality`  to `--minimum-cardinality 1` will eliminate this optimization, including all fields in the base indexes generated by Step 3 of the algorithm.
- Increase `--minimimum-reduction` up to a higher value then `--minimum-cardinality 0.7`, such as `--minimum-cardinality 0.85` or `--minimum-cardinality 1.00` to allow more fields to stay in the indexes, even if they don't add much specificity to the index.

## If you want simpler indexes, that only have the minimum necessary fields

- Use `--no-index-extension` to disable Step 6 of the optimization algorithm, which adds back fields to the resulting indexes that it eliminated in Steps 4 and 5


# Modes of Usage

There are a bunch of different ways of installing and using the Mongo Dynamic Indexer,
with varying complexity and performance implications. 

Many of the cons of each of these modes could be alleviated by further development. Feel
free to contribute!


## Static Analysis

Static analysis mode is the simplest possible way to deploy the dynamic indexer.

In this mode, you don't deploy the dynamic indexer as a service. Instead, you run set it
up temporarily, and allow it to monitor the queries but don't allow it to make any changes.

During this period, you might do a load test of some sort in order to get a fair sample of
different queries being made on your system.

Afterwards, you take a look at its output and see the indexes that it recommends. You would
then hard-code these recommended indexes into your code base.

### Steps

#### Step 1 - Run the dynamic indexer in plain vanilla mode

    mongodynamicindexer -d mongodb://localhost:27017/your_database -p 2

#### Step 2 - Make a representative sample of queries in your system

You will need to perform a load test or something which sends a representative sample of 
queries through the system. The dynamic indexer will print out its recommendations every
60 seconds, but will not make any actual changes to the indexes.

You would then take these indexes and hard-code them in your application logic.

It is extremely important that both the data in your database, and the queries that you make
during the static analysis are consistent with what you will see in your production environment.
If you do this on a development machine with very little data, the statistical information on
your fields will not be very good, and thus the reccomended indexes will be bad.

### Caveats

Similar caveats to the other profiling based modes.

- Mongo has a habit of resetting the profiling level back to off when it restarts.
  Therefore, you should ensure that if mongo restarts, mongodynamicindexer also 
  restarts so that it can reenable profiling when it starts.
- Profiling only works on a single server. If you have the dynamic indexer enabled
  on a specific server (primary or secondary), it will only see queries made on that
  server! Therefore, the indexer should be enabled on the primary server. Sharding
  is a whole other can of worms that is not supported in this mode.
- The indexer should only be installed on one database server at a time!

### Pros
- You don't have to run profiling mode in production
- Smallest performance impact
- Least complexity - does not require installing a new service on your servers.
  This can be done in an ad-hoc manner, and the recommendations put through your
  normal database change process.

### Cons
- Quality of the resulting indexes depends entirely on the quality of the queries provided
- Requires you to manually copy the indexes into your code
- Unable to monitor actual queries to make sure that they are using the expected indexes.
- Must be done manually on a regular basis to ensure that your indexes match your current
  needs and queries.
- If there is significant differences between the data that you test with, and the data
  on the environments the indexes are actually being used on, then you will not get the
  most optimal indexes. Particularly when it comes to field cardinality!


## Dynamic Service - Mongo Slow Query Profiling Mode

Slow Query Mode is the possible way of deploying the dynamic indexer as a service. Slow Query
Mode is easy to deploy and has low performance implications. Essentially, what we do is 
enable Mongo database profiling in 'slow query mode'. Every database query that takes
over 100ms gets profiled. The dynamic indexer will then pick up an analyze that query,
and create the necessary indexes to ensure that query goes quickly in the future.

Please see https://docs.mongodb.com/manual/tutorial/manage-the-database-profiler/ to learn
more about Mongos profiling mode.

### Steps

#### Step 1 - Delete your existing indexes

The dynamic indexer will not touch any existing indexes in the system. It will only 
modify indexes whose name starts with "auto_", used to indicate that its an automatically
created index managed by the mongo dynamic indexer.

Therefore, you must delete your existing indexes. If you have unique or sparse indexes,
you may need to keep them because they affect the behaviour of your system. But you can
safely delete any indexes that you have only for performance

    $ mongo
    MongoDB shell version: 2.6.10
    connecting to: test
    > use mydatabase
    switched to db mydatabase
    > db.collection.dropIndexes()
    {
    	"nIndexesWas" : 5,
    	"msg" : "non-_id indexes dropped for collection",
    	"ok" : 1
    }


#### Step 2 - Run the dynamic indexer with slow-query profiling enabled

    mongodynamicindexer -d mongodb://localhost:27017/your_database -c -p 2

Now in a live deployment of course, you would create this as a service on your system,
using something such as upstart or system-v.

### Caveats

- Mongo has a habit of resetting the profiling level back to off when it restarts.
  Therefore, you should ensure that if mongo restarts, mongodynamicindexer also 
  restarts so that it can reenable profiling when it starts.
- Profiling only works on a single server. If you have the dynamic indexer enabled
  on a specific server (primary or secondary), it will only see queries made on that
  server! Therefore, the indexer should be enabled on the primary server. Sharding
  is a whole other can of worms that is not supported in this mode.
- The indexer should only be installed on one database server at a time!

### Pros
- Only creates indexes for queries that are slow. This can prevent the system from creating
  a bunch of indexes for queries that are performing well
- Minimizes the performance impact in mongo compared to enabling profiling for every query
- Captures all queries being made on your database

### Cons
- A single strange query can cause an index to be created permanently
- Hard to use in complicated architectures involving sharding and replication
- Can capture unexpected queries, like ones coming from the Mongo Shell
- Unable to example queries to ensure that the expected index is being used


## Dynamic Service - Mongo full profiling mode with only recent query profiles

This mode is similar to slow-query mode, except that you enable full profiling for all
queries. This has more of a performance implication, but has the benefit that you are
not keeping around indexes for queries that are no longer being made. It will only
keep around indexes for queries that have been made at least in the last N days, where
N is configurable. 

Please see https://docs.mongodb.com/manual/tutorial/manage-the-database-profiler/ to learn
more about Mongos profiling mode.

### Steps

#### Step 1 - Delete your existing indexes

The dynamic indexer will not touch any existing indexes in the system. It will only 
modify indexes whose name starts with "auto_", used to indicate that its an automatically
created index managed by the mongo dynamic indexer.

Therefore, you must delete your existing indexes. If you have unique or sparse indexes,
you may need to keep them because they affect the behaviour of your system. But you can
safely delete any indexes that you have only for performance

    $ mongo
    MongoDB shell version: 2.6.10
    connecting to: test
    > use mydatabase
    switched to db mydatabase
    > db.collection.dropIndexes()
    {
    	"nIndexesWas" : 5,
    	"msg" : "non-_id indexes dropped for collection",
    	"ok" : 1
    }


#### Step 2 - Run the dynamic indexer with regular profiling in recent query mode

    $ mongodynamicindexer -d mongodb://localhost:27017/your_database -c -p 2 --recent-queries-only-days 14

The 14 here represents the number of days that is considered "recent".

In a live deployment, you would create this as a service on your system, using something 
such as upstart or system-v.

### Caveats

Similar caveats to to slow query mode

- Mongo has a habit of resetting the profiling level back to off when it restarts.
  Therefore, you should ensure that if mongo restarts, mongodynamicindexer also 
  restarts so that it can reenable profiling when it starts.
- Profiling only works on a single server. If you have the dynamic indexer enabled
  on a specific server (primary or secondary), it will only see queries made on that
  server! Therefore, the indexer should be enabled on the primary server. Sharding
  is a whole other can of worms that is not supported in this mode.
- The indexer should only be installed on one database server at a time!

### Pros
- Ensures that every single query made in your system is covered as best as possible by
  a proper index.
- Captures all queries being made on your database
- Only creates indexes for queries that have actually been seen recently.
- As your system evolves, your indexes will automatically evolve with it.
- The dynamic indexer can examine profiling results and ensure that the expected indexes
  are actually being used! This will allow you to pick out anomalies in your data
  as well as flaws in mongo dynamic indexer.

### Cons
- Larger performance impact because of using mongo in full profiling mode
- Might create more indexes then required to achieve good performance
- Hard to use in complicated architectures involving sharding and replication
- Can capture unexpected queries, like ones coming from the Mongo Shell

### Side note - why not have both slow query mode AND recent query mode at the same time?

This will cause instability. Say you have a slow query:

    {"name": "brad", "email": "brad@example.com"}

And the dynamic indexer creates an index for it:

    {name: 1, email: 1}

With these index now, the query is no longer slow! The dynamic indexer will no longer
get notified that this query is being made. Thus, after 14 days (or whatever option you
set), the index will automatically get deleted because the dynamic indexer doesn't believe
that query is being made anymore!

Once the index is gone, the query will become slow again. The dynamic indexer will see it
once again, and then that exact same index will get recreated.

## As a library (under construction)

In this mode, you use the dynamic indexer as a library, and manually forward it the queries
that are being made on the system.

This gives you a lot more flexibility. For example, if you have a cluster deployment, you could
forward all of the queries being made from all API servers through a message buffer like RabbitMQ
into a receiver process. This would ensure that you are actually getting all the queries being 
made across your cluster. In the profiling mode, the only queries seen are the ones being made on
*that* database server that the indexer is connected to.

NOTE! This mode is not currently supported, it is a hypothetical mode that might be supported
very soon.

### Pros
- Ensures that you only capture queries of your choosing. Random queries being made on your
  database by the Mongo shell will not have indexes created for them.
- Can be used with recent-query mode
- Allows more custom configuration of the expected performance for each query
- Doesn't depend on Mongo profiling, so the performance is entirely within your control

### Cons
- Requires a lot of manual integration - significantly more development effort to buffer and
  forward the queries being made.
- Requires you to write an application in NodeJS

# Query Metadata

The Dynamic Indexer is able to use metadata that attached to your queries through the use of $comment: https://docs.mongodb.com/manual/reference/operator/meta/comment/

All you need to do is attach a $comment to a particular query which contains a valid object. Any $comment which contains an object will be interpreted
by the Dynamic Indexer as containing metadata intended for it. Any $comment which isn't an object (such as a string) will be ignored.

For example, from the Mongo shell, you might make a query that looks like this:

    MongoDB shell version: 2.6.10
    connecting to: test
    > db.users.find({name: "awesome person", $comment: {source: "shell.sh:1"}})

The Dynamic Indexer will then be able to pick up this comment and use it to tell you where the query came from. The following are supported pieces of metadata:

    {
        source: "string"   // This is meant to specify where the query came from, such as the file and line number
                           // or internal machine name. This can help you track down which indexes are coming from 
                           // where in your application.
        version: "string"  // An additional optional piece of data that can go with "source". It allows you to track
                           // which version of your application the query came from. Useful if you use file & line
                           // numbers for 'source', since the exact line number changes when the source code is changed.
    }

Currently this is the only piece of metadata supported. These sources will be shown in the summary of changes.

As an example, take a look at the following code for the Mongoose ORM for MongoDB in NodeJS. It adds in line numbers to every query made on a model object:

    "use strict";
    
    const underscore = require('underscore');
    
    /**
     * This function takes a mongoose model, the one created by mongoose.model("name", schema),
     * and wraps all of its query methods like find, findOne, update, etc... with versions that
     * automatically add $comment to the query with some JSON specifying the source of the query -
     * this can be used by the query optimizer to help us analyze the queries
     */
    module.exports.wrapQueriesWithMetadata = function wrapQueriesWithMetadata(model)
    {
        const packageContent = require('../package.json');
        let version = "";
        if (packageContent.version)
        {
            version = packageContent.version;
        }
    
        function getCallerInfo()
        {
            const err = new Error();
            const callingFrame = err.stack.split("\n")[3];
            let callerInfo = callingFrame.substr(callingFrame.lastIndexOf("/") + 1);
            callerInfo = callerInfo.substr(0, callerInfo.lastIndexOf(":"));
            return callerInfo;
        }
    
        function wrapFunction(originalFunc)
        {
            return function ()
            {
                const args = Array.from(arguments);
                let originalQuery = args[0];
                if (!originalQuery)
                {
                    originalQuery = {};
                }
    
                // Create a shallow clone that we can attach $comment to. This
                // ensures that we don't unnecessarily modify the callers object
                const query = underscore.extend({}, originalQuery);
                query.$comment = {source: getCallerInfo(), version: version};
    
                // Write the modified query back to args
                args[0] = query;
    
                return originalFunc.apply(model, args);
            };
        }
    
        model.find = wrapFunction(model.find);
        model.findOne = wrapFunction(model.findOne);
        model.findOneAndUpdate = wrapFunction(model.findOneAndUpdate);
        model.count = wrapFunction(model.count);
        model.update = wrapFunction(model.update);
    };




# How does it pick indexes?

Great question! There are a bunch of steps involved in order for the dynamic indexer to
produce its recommended indexes. 


## Step 1: Collect and break down the queries
First, the dynamic indexer starts tailing the system.profile collection, watching queries
live as they happen.

For each query, it breaks it down all of the fields involved to a query profile consisting of 3 categories:

- Exact match fields. E.g. {"name": "bradley"} contains an exact match for "name"
- Sort fields. E.g. sorting on {"birthday": -1} would have the sort field "birthday"
- Range / Multi-value fields. All manner of complex queries go here, such as $le, $gte, $regex, $neq, $elemMatch, $exists, $mod, and so forth. The reason is that all of these have these queries can produce multiple values.

The system also evaluates both sides of the $or as seperate queries, so a single query 
might produce multiple query profiles. E.g. this query:

    {
        "name": "bradley",
        "$or": [
            {
                email: {$exists: null}
            },
            {
                status: "registered",
                email: "genixpro@gmail.com"
            }
        ]
    }
    sort: {birthday: -1}

Would produce two query profiles:

    {
        exact: ["name"],
        sort: {"birthday": -1},
        range: ["email"]
    }

and

    {
        exact: ["name", "status"],
        sort: {"birthday": -1},
        range: ["email"]
    }

If you have a bunch of layers of nested $ors, then the number of resulting query profiles
can quickly become large.

Lesson: don't write insane queries! Remember: mongo actually has to evaluate your query.
The dynamic indexer can't index its way around your poor design.

At this stage we also filter out only query profiles that we have seen a minimum number of
times. This minimum is set with `--minimum-query-count`. By default the minimum is 1, meaning
it will recommend an index for every single query it sees, even if it only sees it once.

Only queries that meet the minimum will proceed to the next stage.

## Step 2: Randomly sample the collection to statistics for each field

At this point, the system goes through the collection and grabs 1,000 random objects in
order to determine cardinality and other information about each field.

The dynamic indexer will save the statistical information it collects for 30 days (by default),
so it doesn't need to recompute it very often. This state is saved in a collection of its own,
the "index-optimizer" collection within your database. The collection will contain a single object
with the complete internal state of the dynamic indexer. If you need to reset the collection
statistics, you can go into the object and delete the "sampler" field and all its contents.

Then restart the dynamic indexer and it will resample the database for statistical information.

## Step 3: Compute the optimal index for each query profile

Now, we need to compute the optimal index for each query profile. The system follows a few
rules of thumb are as follows:

- First, exact match fields, sorted by highest cardinality first
- Then, sort fields in their exact sorting directions
- Finally, all range/multi-value fields, sorted by lowest cardinality first

See https://emptysqua.re/blog/optimizing-mongodb-compound-indexes/#equality-range-sort and
http://blog.mlab.com/2012/06/cardinal-ins/ for more information on how these rules were
formulated. Neither of these blogs mention sorting the exact match fields by any specific
cardinality. We simply have done this so that the order of fields is always consistent when
creating indexes. This allows more of the indexes to be folded into each other because they
are index prefixes of each other - same performance but with fewer indexes! This gets
discussed more later, in Step 4.

There are several additional things to consider, which the Mongo Dynamic Indexer is
automatically smart enough to handle.

- not all fields are worth indexing
- not all fields are even able to be indexed
- some indexes can't even be created, because of limitations on mongo (such as indexes over
  parallel arrays, see https://docs.mongodb.com/manual/core/index-multikey/#limitations)

Fields with very low cardinality, such as true/false values or fields with only a few
possible enum values, might not be worth including in the index. This is particularly
true if almost all of the objects in the database have the same few values for
a particular field. (Although the dynamic indexer is not yet smart enough to collect or
use statistical information on that level of detail. Feel free to contribute!)

By default (at the time of writing), the indexer will remove any fields with a 
cardinality lower then 3. For the most part, this will only eliminate boolean fields.
However, you can raise this cardinality minimum using the --minimum-cardinality 
option on the command line. Remember this cardinality is based on computing the
number of distinct values in the random sample of 1,000 objects taken from the database.

Next, not all fields are even able to be indexed. Mongo has a hard limit that the
complete size of all the indexed fields for a single entry must not exceed 1kb.
Therefore, the dynamic indexer will consider any fields which have values that exceed
1/2kb in size to be trouble. However, not all is lost! While these fields have to be
removed from the main index, there is still one thing that can be done. The dynamic
indexer will create a separate "hashed" index for that field. This hashed index is 
able to support a few types of queries, such as exact match and $exists type queries, 
thus recuperating some of the lost speed.

If you see some single-field indexes that say "hashed", like {text: "hashed"} in your
results, know that its because you made a query on that field, but its unable
to be indexed.

Lastly, for query profiles that would create an index involving two parallel arrays,
an inherent limitation in Mongo, we create two separate indexes, one with each array.
This is the best that can be done in this case - Mongo should be able to use a Set
intersection between both indexes sometimes, but that depends entirely on the query.

As an example, consider we have the following hypothetical object:

    {
        password: "hashed_nonsense",
        names: [
            {
                first: 'brad',
                last: 'awesome'
            },
                first: 'jillian',
                last: 'awesome'
            },
                first: 'erica',
                last: 'cool'
            }
        ],
        statuses: [
            {
                date: Date("July 1, 2016"),
                status: "active"
            },
            {
                date: Date("July 2, 2016"),
                status: "active"
            }
        ]
    }

And we tried to make a query that involved both the names array and statuses array:

    {"names.first": "brad", "statuses.date": Date("July 2, 2016"), password: "hashed_nonsense"}
    
In theory, we would want the following index created:

    {"names.first": 1, "statuses.date": 1, "password": 1}

But Mongo is unable to do this for you - it can not create indexes over two parallel 
arrays. See https://docs.mongodb.com/manual/core/index-multikey/#limitations

So instead, the Mongo Dynamic Indexer will do the next best thing, which is to break
it apart into two separate indexes, and let Mongo sort out the rest:

    {"names.first": 1, "password": 1}
    {"statuses.date": 1, "password": 1}

After all of this is said and done, a single query profile will result in one or more
optimized indexes. Given that with $or conditions, a single query can result in multiple
query profiles, and each query profile can require a number of indexes if you query
of arrays, its easy to see that poorly written, overly complicated queries could balloon
into a bunch of required indexes to make it fast.

Lesson: the dynamic indexer can't index its way around your poor design. If you write 
queries so complex where there is no possible way it could be done quickly, you should 
expect that it is not executed quickly, even when its backed by several well chosen 
indexes. I can not repeat this enough.

## Step 4: Eliminate indexes which are prefixes of other indexes

Now the single most important step in terms of minimizing the total number of indexes,
since each index adds to the cost of your operation. Indexes which are an exact prefix
of other indexes can be eliminated. Queries that only require the fields of the smaller
index can use the larger index with no penalty. For example, say you have the following
indexes:

    {"name": 1}
    {"name": 1, "status": 1}
    {"name": 1, "email": 1}
    {"email": 1}
    {"email": 1, "status" 1}
    {"name": 1, "email": 1, "status" 1}
    
There are several indexes that can be eliminated, because they are superfluous. 
{"name": 1} is a prefix of 3 other indexes:

    {"name": 1, "status": 1}
    {"name": 1, "email": 1}
    {"name": 1, "email": 1, "status" 1}

And thus can be eliminated. Similarly, {"email": 1} is an index prefix of a single
index:

    {"email": 1, "status" 1}

Additionally, in a second stage of reduction, you can see that {"name": 1, "email": 1}
is itself an index prefix of a longer index:

    {"name": 1, "email": 1, "status" 1}

Thus, after the reduction step, we end can eliminate half of all the indexes we needed
to create! We now only need: 

    {"name": 1, "status": 1}
    {"email": 1, "status" 1}
    {"name": 1, "email": 1, "status" 1}

In order to cover all 6 different query profiles!

## Step 5: Randomly sample the collection for index statistics and eliminate unnecessary fields

Here is one of the most important steps in the process. In this stage, we take all of the "optimal"
indexes recommended by the last reduction in Step 4, and then uses a random sample of data in order 
to calculate how much each successive field on the index narrows down the data. Fields which don't
actually narrow down the data (because they might be highly correlated with fields earlier in the index) 
can be eliminated. 

This can cause a lot more indexes to be eliminated, because it distills the indexes down to their
purest essence, with the unnecessary fields removed. The main purpose of this is so that more queries
can be combined together to share indexes via Step 4.

This functionality can be disabled by using `--minimum-reduction 1`. This will ensure that
all fields are kept on the index, regardless of whether they actually narrow down the
data any.

As an example, lets say you have the following objects:

    {"name": "brad", birthday: "june 3"}
    {"name": "brad", birthday: "march 22"}
    {"name": "anne", birthday: "september 6"}
    {"name": "rebecca", birthday: "june 3"}

And the system initially proposes the following index:
    
    {"name": 1, "birthday": 1}

The system will now randomly sample the database to determine field statistics. It should end
up with the following stats:

    stats: name: 1.33/4=33.25%;   birthday: 1/1.33=75.00%;

What its saying here is that, on average, the `name` field narrows the data down to about 33% of
the original entries. Adding on the `birthday` field only narrows down the data to 75% of those
entries (on average). With the default settings, the system is now going to eliminate the birthday
field from the index - it simply doesn't narrow down the data enough. Once you have a persons name,
you've already pretty much narrowed it down to 1 object.

After performing this step, the system will go back to Step 4 and perform index reduction, and then
come back to Step 5 to take another random sample. This is because we can only remove a single field 
at a time. When a field is removed from the index, you can't make any assumptions about what the 
statistics for the smaller index will look like. By removing a field, the other fields become more
important in providing the specificity the index needs. Thus, this step will only remove one field 
at a time, then do a reduction pass through Step 4, and then come back to Step 5 for another sample.

It will continue to repeat this until there are no more changes to be made. If you have a lot of very
large data and you are making a lot of complicated queries that involve many fields, there can be
many passes between Step 4 and Step 5, each sampling 100,000 objects. It can take a long time. 
Even setting `--sample-speed 1`, it can still be several hours of back and forth in order for the
dynamic indexer to resolve to the absolute most optimal indexes. Don't worry, its worth it.

As you can see, this step can enormously cut down on the total number of indexes recommended
by the system, particularly if there is a lot of correlation between your various fields.
Depending on your data, however, this might end up being too aggressive - folding too many queries
together. If thats the case, try increasing `--minimum-reduction` above 0.7, to 0.8 and 0.9, so 
that it allows more fields through even if they don't reduce that much.


## Step 6: Index Extension

Steps 4 and 5 will, in combination, do a great job at finding which queries can share indexes. Their
primary purpose is to ensure that we don't end up generating hundreds of different indexes just because
you make a great diversity of different queries. They distill each query down to the most important fields,
and ensures maximal reuse of indexes.

However, its possible that the removal of fields by Step 5, (and also by the cardinality minimums in Step 3)
have gone too far - they have resulted in general purpose indexes that don't fully cover the most important
queries in your system.

So by this stage, we already know how many resulting indexes we are going to have and which queries
those indexes are intended to cover. So now we ask, for a given index, is it possible to add any fields
to the end of the index.

In order to choose what fields to tag onto the end of the index, it just goes to each query profile and
looks at eligible fields. An eligible field is an exact-match or range-match field that was removed
during Steps 3 or 5. It will add the field which is used by the most query profiles based on their
usage-count - e.g. it will add in the field that would be useful by the most queries.

Although these additional fields might not narrow down the results by any significant extend (and you
will see that in the index statistics), they serve two useful purposes:

- They send a stronger signal to Mongo that it should use that index for those queries. For example, when an index totally covers a query, Mongo will straight to using it without generating alternatives.
- In some cases they can improve the performance, particularly when there is a lot of rounding error because the number of objects you are sampling is small relative to the diversity of your data

You might ask, why go to all the effort to be minimalistic by removing fields in Steps 3 to 5, only
to add those fields back on in this Step. The reason is that Steps 3-5 are concerned with figuring out
which queries could share which indexes, in order to produce the smallest set of indexes that completely
cover your queries. Otherwise, the system might end up recommending 250 different indexes if you have
250 different queries. Steps 3-5 have the effect of moving the *most important* fields to the front
of the index. Step 6 adds back on unimportant fields in order to get whatever performance gain
they can reap.

It should be noted that this is not guaranteed to improve results - although you won't end up with
more indexes because of this step, you will end up with larger indexes because of the additional fields.
You can disable this step by using --no-index-extension if you just want the minimalistic indexes
without the extensions. The minimalistic indexes should give you great performance - this step is just
meant to add an extra 10% for certain edge cases.


# Troubleshooting

## Error: MongoError: No more documents in tailed cursor

Please ensure that you have database profiling enabled, and that you have made at least one
query. Otherwise, the profiling collection will be empty, resulting in this error.

You must restart the program after receiving this error.

## I am getting no output

Please ensure that database profiling is enabled.

This can also happen if you run the program with --show-changes-only, and you already
happen to have all of the indexes you need.

## What are all these indexes with 0 query profiles?

These are the indexes that the program found that it is not managing. It will *not*
delete your existing indexes for you. Any and all indexes that are created outside
the dynamic indexer will be left *as-is*. This allows you the freedom to combine
your own indexes with the ones that dynamic indexer recommends.

If you want to give total control to the dynamic indexer, you should delete these
existing indexes!

Note that currently, there is one exception to this which is if your index name 
begins with "auto_", such as when you are indexing a field "auto". The prefix
"auto_" is how the dynamic indexer knows a particular index is one that its managing,
so it could get confused in this one case.

## How do I reset the internal state of the dynamic indexer?

Delete the data in the `index-optimizer` collection which is used by the dynamic indexer
to hold its internal state. Alternatively, you can just delete the `querySet` or
the `sampler` fields on the object it creates in that collection, if you just want to
reset the known queries or sampling data without resetting the other.

## Can I copy the internal state of the dynamic indexer between databases?

Yes as long as the database name is the same.

If the database name changes, then no, at least not yet. We have to change a bunch of places
in the dynamic indexer code which uses `namespace` to just use `collectionName` in order
to allow this. Feel free to contribute!


# TODO

## Bugs
- I believe there is a bug in the detection of fields that are too long to index, as some Buffer fields (cppBuffer on Annotation) are being left in the results
- There seems to be a bug with the detection of the existing indexes, as allhe indexes are being put under create regardless of the plan

## General
- Put an eslint file into the repository.
- Rename everything about 'range' matches to 'multivalue' matches

## Documentation to write
- Dependencies re: packages, mongo versions

## General Features
- The sampling for index statistics could be significantly improved:
    - When sampling, if its computing cardinalities for the same prefix (but for different indexes), then it should share the computation in memory
    - When its done sampling, it should store statistics for every index prefix of the indexes it was computing - This saves time because the most common field to be removed during reduction is the last field on the index
- Gather statistics on how often each index is used, so we know which indexes are the most important
- Need a way to trigger index synchronization only at 4am
- Logging using syslog

## Library
- Refactor the various classes in the application so that it can be used in a flexible manner as a library. The application should just use the library and weave it into a whole.
- A way for it to $hint to mongo which index it should use (at least for comparison with mongos internally chosen index)
- Should be able to automatically wrap mongoose and native mongodb objects (or maybe only native mongodb) and provide things like line numbers in $comment metadata automatically

## Optimization improvements
- There is a bug in the index simplification algorithm. When computing the index statistics, to see which fields to eliminate, it should not be considering the sort field in the reduction statistics, because the sort field is not used actually used to narrow down the results
- In the index extension algorithm, if there is more then one field that it could add which have exactly the same summed usageCount, then it should consider the cardinality of the fields next - lowest cardinality first (same as regular exact match).
- Would be nice if you could provide a configuration file for optimization, as using the command line gets a bit tedious when many optimizations are involved
    - In the configuration file, you might be able to specify a list of fields to ignore for the purposes of indexing
- (Maybe) In certain cases, it might be permissible to allow some $in's and other queries to be called 'exact' instead of multi if there is only a couple of values being matched against
- Might want to break up multi-match fields into two different priority levels, e.g. $in's with only a couple of values would be ranked higher then $lt or $gt with many values
- Any field with a Buffer object should automatically be a 'hashed' field (should be able to turn this on/off)
- Need to refactor so that there is more "componentization" of the various optimizations, so that they can independently be turned on and off and configured, possibly even rearranged where permitted.
    - Possibly a design where an optimization component can hook at different stages of the process, such as creating the query profile, creating naive indexes, creating optimized indexes, and rearranged and reducing indexes.
- Would be nice if it could analyze your data and your queries and try to recommend shard keys, or at least analyze ones that you provide. A general understanding of sharding would be good for index selection would also be good.
- Able to have dynamic cardinality minimums. E.g. a query profile first generates indexes with only high cardinality fields, but gradually allows in more fields if the queries for that profile don't meet the speed requirements
- One identified issue is that a lot of indexes seem to get created where a field might be done as an exact match sometimes and a range match other times. It would be nice to be able to say 'fuck it' and make them all range-matches in some of these cases, to avoid extra indexes.
- Perhaps there needs to be a way of ranking indexes by how important they are. This way you could say you have an upper limit of 30 indexes, and the system will do the best it can to choose 30 indexes that cover all your queries.
- There are some cases where, if we arranged the fields in a different way then by the cardinality minimum, we can sometimes fold more indexes into each other.
    For example, say we have two queries:
        {a:'ok'}
        {a:'ok', b: 'test'}.
    Lets say that A is low cardinality and B is high cardinality. With the current settings, the system will then recommend two indexes:
        {a: 1}
        {b: 1, a: 1}
    Because by default, exact matches are sorted by highest cardinality to lowest cardinality, and only after is index reduction performed.

    In this scenario, we would like the system to be smart enough to rearrange the fields so that you can use just one index:
        {a: 1, b: 1}

    There are a bunch of potential scenarios like this with both the exact and range matches to reduce the number of resulting indexes.


