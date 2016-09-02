/*
 * Modify console.log so that it will print full objects, no matter how many layers of nesting
 */

var util = require('util');
var underscore = require('underscore');

module.exports.apply = function apply()
{
    console.regularLog = console.log;
    console.regularError = console.error;

    function getCallerInfo()
    {
        var err = new Error();
        var stack = err.stack;
        var callingFrame = err.stack.split("\n")[3];
        var callerInfo = callingFrame.substr(callingFrame.lastIndexOf("/") + 1);
        callerInfo = callerInfo.substr(0, callerInfo.lastIndexOf(":"));
        return callerInfo;
    }

    function logProto(regularLog)
    {
        return function()
        {
            // Create text which is appended to the start of each log statement
            var prefix = getCallerInfo();
            while(prefix.length < 30)
            {
                prefix = prefix + " ";
            }
            prefix = prefix + " - ";

            var args = underscore.map(underscore.toArray(arguments),
                function(arg)
                {
                    if(typeof(arg) == 'string')
                    {
                        return arg.replace(/\n/g, "\n"+prefix);
                    }
                    else if(typeof(arg) == 'number')
                    {
                        return arg;
                    }
                    else if(arg instanceof Error)
                    {
                        return arg.stack.toString().replace(/\n/g, "\n"+prefix);
                    }
                    else
                    {
                        return util.inspect(arg, {showHidden: false, depth: null}).toString().replace(/\n/g, "\n"+prefix);
                    }
                }
            );

            args = [prefix].concat(args);

            regularLog.apply(console, args);
        };
    }

    console.log = logProto(console.regularLog);
    console.error = logProto(console.regularError);
};