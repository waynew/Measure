const MongoClient = require('mongodb').MongoClient;
const assert = require('assert');
const path = require('path');
const fs = require('fs-extra');
const async = require('async');
const mu = require('mu2');
const yaml = require('js-yaml');
const wrap = require('word-wrap');
const util = require('util');
const entries = require('object.entries');
if (!Object.entries) { entries.shim(); }

var db;

/*
The way the dashboard is created is this: we have a collection of "widgets",
which are given access to the ghcrawler database and can do whatever they want,
and then return some HTML, and the HTML is assembled into the final static
dashboard.
*/

function loadTemplates() {
    /*
    We first load and compile widget HTML templates for later. This is a
    list of template files found in the templates/*.tmpl folder. We don't dynamically
    load them so that we can have subsidiary files, partials, and the like.
    Realistically, widgets use these by name, so just adding a new one to be
    dynamically picked up doesn't buy us much.
    */
    const TEMPLATES_LIST = ["list", "bignumber", "graph", "dashboard", "front"];

    return new Promise((resolve, reject) => {
        /*
        Load each of the template files and compile them to a template object.
        */
        mu.root = __dirname + '/templates';
        var options = {templates: {}};
        async.map(TEMPLATES_LIST, (tn, done) => {
            mu.compile(tn + ".tmpl", function(err, ctmpl) {
                if (err) {
                    console.warn("Skipping bad template", tn, err);
                    return done();
                }
                done(null, {name: tn, template: ctmpl});
            })
        }, (err, results) => {
            if (err) { return reject(err); }
            var widget_counter = 1;
            results.forEach(r => {
                /*
                Template objects have a render method which returns a node stream.
                We don't really want widgets to have to understand that, so we spin
                up a little function for each template; the widget can then just
                call options.templates.templateName({my:data}, callback) to get their
                data rendered with a template and pass rendered HTML to the callback.
                */
                if (r) {
                    options.templates[r.name] = function(view, done) {
                        var bailed = false, output = [];
                        
                        function doneOK() {
                            if (bailed) return;
                            bailed = true;
                            done(null, output.join(""));
                        }

                        let augmented_view = Object.assign({
                            unique_id: r.name + "_" + widget_counter++
                        }, view);

                        mu.render(r.template, augmented_view)
                            .on('data', function(data) { output.push(data.toString()); })
                            .on('error', function(err) {
                                bailed = true;
                                return done(err);
                            })
                            .on('finish', doneOK)
                            .on('close', doneOK)
                            .on('end', doneOK)
                    }
                }
            })
            return resolve(options);
        })
    });
}

function loadWidgets(options) {
    /*
    So, we need to load the widgets. We don't execute them yet;
    we just load them into a list. This is dynamic, in that we search the widgets
    folder and list everything in it; one of the goals here is that there should be
    as little as possible configuration required. Where we can do something
    automatically, or deduce what should be done, then we should do so; don't require
    a bunch of configuration to be created in order to set all this up. So, any widgets
    in the "widgets" folder are included. A plugin needs to be in a *.js file, and
    may export a function `run(options, callback)` where options is an object with properties
    `db`: an object with properties for each of the relevant ghcrawler collections, which are 
        pull_request_commit, statuses, subscribers, pull_request_commits, deadletter, 
        issue_comments, contributors, stargazers, issue, issue_comment, commits, commit, 
        reviews, review_comments, pull_request, repo, user, issues.
    `templates`: a list of simple HTML templates for widgets. Currently available:
        `list`: takes parameters `title` and `list` and displays a list as requested
        `dashboard`: widgets don't use this. This template is the dashboard itself.
    */
    return new Promise((resolve, reject) => {
        var pth = path.join(__dirname, "widgets");
        fs.readdir(pth, function onRead(err, files) {
            if (err) { return reject(err); }
            async.map(files, function(fn, done) {
                var mod_details;
                try {
                    var name = fn.replace(/\.js$/,'');
                    mod_details = {
                        module: require(path.join(pth, fn)),
                        name: name
                    };
                } catch(e) {
                    console.warn("Skipping ill-formed widget", fn, e);
                    // here mod_details is null, because this didn't load
                }
                done(null, mod_details);
            }, function(err, mods) {
                if (err) { return reject(err); }
                var valid_mods = mods.filter(m => !!m);
                //console.log("Loaded " + valid_mods.length + " widgets");
                return resolve(Object.assign({widgets: valid_mods}, options));
            });
        });
    });
}

function connectToDB(options) {
    /*
    Normal connection to MongoDB. This is the MongoDB being run by ghcrawler.
    */
    return new Promise((resolve, reject) => {
        var url = 'mongodb://localhost:27017/ghcrawler';
        MongoClient.connect(url, function(err, mdb) {
            if (err) return reject(NICE_ERRORS.NO_MONGO_ERROR(err));
            db = mdb;
            //console.log("Connected correctly to server.");
            return resolve(Object.assign({db: mdb}, options));
        });
    })
}

/*
We define some "nice" errors; these have detailed helpful error text to
attempt to make things easier to use.
*/

function NiceError(name, message) {
    this.message = wrap(
        message.replace(/\n +/g, ' ') || 'Badly created nice error', 
        {width: 70}
    );
    this.stack = (new Error()).stack;
    this.isNiceError = true;
}
NiceError.prototype = Object.create(Error.prototype);
NiceError.prototype.constructor = NiceError;

const NICE_ERRORS = {
    NO_CONFIG_ERROR: fn => new NiceError("NoConfigFileError", 
        `I looked for the configuration file, "${fn}", and couldn't find
        it. This file needs to exist to set up which repositories to monitor
        and where to put the generated dashboard file. Please copy
        config.yaml.example to config.yaml and then edit it to taste.`),
    NO_MONGO_ERROR: e => new NiceError("NoDatabaseError", 
        `The database doesn't seem to be running, so I can't get information
        from it. Perhaps you need to run "docker-compose up" in the
        "ghcrawler/docker" directory.

        \n\n(The error is described like this, which may not be helpful:
        "${e}".)`),
    BAD_CONFIG_ERROR: (e, fn) => new NiceError("MisunderstoodConfigError",
        `I couldn't understand the configuration file "${fn}". The issue
        is on line ${e.mark.line + 1} at position ${e.mark.position}.
        
        \n\n(The error is described like this, which may not be helpful:
        "${e.reason}".)`),
    NO_OUTPUT_DIR_CONFIGURED: (fn) => new NiceError("NoOutputDirectoryError",
        `I couldn't understand the configuration file "${fn}". The output directory
        doesn't seem to be set correctly: it needs to be a path to a directory where
        the dashboard will be created.`),
    NONSTRING_OUTPUT_DIR_CONFIGURED: (fn) => new NiceError("NoOutputDirectoryError",
        `I couldn't understand the configuration file "${fn}". The output directory
        doesn't seem to be set correctly: it needs to be a path to a directory where
        the dashboard will be created, and a single string, not an array. The line
        in ${fn} should look like this:

        \noutput_directory: dashboard
        \nor
        \noutput_directory: /path/to/dashboard`),
    BAD_OUTPUT_DIR_CONFIGURED: (e, fn, od) => new NiceError("OutputDirectoryError",
        `I couldn't understand the configuration file "${fn}". The output directory
        is set to ${od}, but I couldn't use that directory.
        
        \n\n(The error is described like this, which may not be helpful:
        "${e}".)`),
    COULD_NOT_WRITE_OUTPUT: (e, ofn) => new NiceError("OutputWriteError",
        `I couldn't write the dashboard output file. I was trying to write it to
        ${ofn}, but that didn't work, so I'm giving up.
        
        \n\n(The error is described like this, which may not be helpful:
        "${e}".)`),
    WIDGET_ERROR: (e, widget) => new NiceError("WidgetError",
        `One of the dashboard widgets ("${widget.name}") had a problem, 
        so I've skipped over it. This is really an internal error, and
        should be reported.
        
        \n\n(The error is described like this, which will help in the report:
        "${e.message}, ${e.stack}".)`)
}

function readConfig(options) {
    /*
    The config is a yaml file, because that's easier to write for community
    managers than json, which is picky about formatting.
    We try to detect as many issues as possible and provide useful help.
    */
    const config_file_name = 'config.yaml';
    return new Promise((resolve, reject) => {
        try {
            var doc = yaml.safeLoad(fs.readFileSync(config_file_name, 'utf8'));
        } catch (e) {
            if (e.code === "ENOENT") { return reject(NICE_ERRORS.NO_CONFIG_ERROR(config_file_name)); }
            if (e.name === "YAMLException") { return reject(NICE_ERRORS.BAD_CONFIG_ERROR(e, config_file_name));}
            return reject(e);
        }
        if (!doc.github_repositories || !Array.isArray(doc.github_repositories)) {
            return reject(NICE_ERRORS.NO_REPOS_CONFIGURED(config_file_name));
        }
        if (!doc.output_directory) {
            return reject(NICE_ERRORS.NO_OUTPUT_DIR_CONFIGURED(config_file_name));
        }
        if (typeof doc.output_directory !== "string") {
            return reject(NICE_ERRORS.NONSTRING_OUTPUT_DIR_CONFIGURED(config_file_name, doc.output_directory));
        }
        try {
            var ods = fs.statSync(doc.output_directory);
            return resolve(Object.assign({userConfig: doc}, options));
        } catch(e) {
            if (e.code === "ENOENT") {
                fs.ensureDir(doc.output_directory, e => {
                    if (e) {
                        return reject(NICE_ERRORS.BAD_OUTPUT_DIR_CONFIGURED(e, 
                            config_file_name, doc.output_directory));
                    }
                    return resolve(Object.assign({userConfig: doc}, options));
                })
            } else {
                return reject(NICE_ERRORS.BAD_OUTPUT_DIR_CONFIGURED(e, config_file_name, doc.output_directory));
            }
        }
    })
}

/* These are basically monkeypatches. The top level keys are collections; inside that are methods.
   Each monkeypatch defines a function with parameters (repo, existing); this means that when
   a widget calls db.issue.find({whatever:foo}), the {issue: {find: ...}} monkeypatch will get called with
   a repo parameter naming a github repository ("stuartlangridge/sorttable", frex) and the existing
   query ({whatever:foo}). It is the monkeypatch's job to return a new dict, to be used instead of
   "existing", which does whatever "existing" does PLUS also limits the query to only those documents
   matching the repo name that was passed in. */
const LIMITS = {
    repo:{
        issue: {
            find: (repo, existing) => {return {$and: [existing, {
                repository_url: {$regex: new RegExp(repo + "$")}}]}},
            count: (repo, existing) => {return {$and: [existing, {
                repository_url: {$regex: new RegExp(repo + "$")}}]}},
            distinct: (repo, existing) => {return {$and: [existing, {
                repository_url: {$regex: new RegExp(repo + "$")}}]}},
            aggregate: (repo, existing) => {
                var nexisting = existing.slice();
                nexisting.unshift({$match: {repository_url: {$regex: new RegExp(repo + "$")}}});
                return nexisting;
            }
        },
        issue_comment: {
            find: (repo, existing) => {return {$and: [existing, {
                url: {$regex: new RegExp(repo + "/issues/comments/[0-9]+$")}}]}},
            count: (repo, existing) => {return {$and: [existing, {
                url: {$regex: new RegExp(repo + "/issues/comments/[0-9]+$")}}]}},
            distinct: (repo, existing) => {return {$and: [existing, {
                url: {$regex: new RegExp(repo + "/issues/comments/[0-9]+$")}}]}},
            aggregate: (repo, existing) => {
                var nexisting = existing.slice();
                nexisting.unshift({$match: {url: {$regex: new RegExp(repo + "/issues/comments/[0-9]+$")}}});
                return nexisting;
            }
        },
        pull_request: {
            // pull requests in the data don't link directly to their repo, so parse their url
            find: (repo, existing) => {return {$and: [existing, {
                url: {$regex: new RegExp(repo + "/pulls/[0-9]+$")}}]}},
            count: (repo, existing) => {return {$and: [existing, {
                url: {$regex: new RegExp(repo + "/pulls/[0-9]+$")}}]}},
            distinct: (repo, existing) => {return {$and: [existing, {
                url: {$regex: new RegExp(repo + "/pulls/[0-9]+$")}}]}},
            aggregate: (repo, existing) => {
                var nexisting = existing.slice();
                nexisting.unshift({$match: {url: {$regex: new RegExp(repo + "/pulls/[0-9]+$")}}});
                return nexisting;
            }
        }
    }
}

function runWidgets(options, limit) {
    /*
    For each of our loaded widgets, we pass it the database connection information
    it needs, and a list of templates it can use; it then calls the callback with
    some HTML which it can generate any way it likes.
    */
    return new Promise((resolve, reject) => {
        options.db.collections((err, colls) => {
            if (err) { return reject(err); }
            var colldict = {};
            colls.forEach(c => {
                colldict[c.collectionName] = c;
            })

            // Monkeypatch the find, count, and aggregate functions
            Object.entries(colldict).forEach(([collname, coll]) => {
                let replacements = LIMITS[limit.limitType][collname];
                if (replacements) {
                    Object.entries(replacements).forEach(([method, fixQuery]) => {
                        let orig = coll[method];
                        coll[method] = function() {
                            let nargs = Array.prototype.slice.call(arguments);
                            let argIndex = 0;
                            if (method == "distinct") { argIndex = 1; } // bit of a hack, this.
                            nargs[argIndex] = fixQuery(limit.value, nargs[argIndex]);
                            //console.log(limit.value, collname, method, util.inspect(nargs, {depth:null}));
                            return orig.apply(coll, nargs);
                        }
                    })
                }
            })

            var in_params = {db: colldict, templates: options.templates};
            async.map(options.widgets, function(widget, done) {
                widget.module(in_params, function(err, result) {
                    if (err) {
                        console.error(NICE_ERRORS.WIDGET_ERROR(err, widget).message);
                        return done();
                    }
                    return done(null, {html: result, widget: widget.name});
                });
            }, function(err, results) {
                var htmls = results.filter(h => !!h);
                return resolve(Object.assign({htmls: htmls, limit: limit}, options));
            })
        });
    });
}

function assembleDashboard(options) {
    /*
    Pass all the collected HTML outputs from the widgets to the dashboard
    template, which gives us an actual dashboard. Save that to the output
    file as defined in the config.
    */
    return new Promise((resolve, reject) => {
        options.templates.dashboard({widgets: options.htmls, subtitle: options.limit.value}, (err, output) => {
            if (err) return reject(err);
            const outputSlug = options.limit.value.replace("/", "--") + "-index.html";
            const outputFile = path.join(options.userConfig.output_directory, outputSlug);
            options.outputFile = outputFile; options.outputSlug = outputSlug;
            fs.writeFile(outputFile, output, {encoding: "utf8"}, err => {
                if (err) {
                    return reject(NICE_ERRORS.COULD_NOT_WRITE_OUTPUT(err, outputFile));
                }
                return resolve(options);
            })
        })
    });
}

function frontPage(options) {
    return new Promise((resolve, reject) => {
        let links = options.repo_output_pairs.map(op => {
            return {
                link: op.outputSlug,
                title: op.repo
            }
        })
        options.templates.front({links: links}, (err, output) => {
            if (err) return reject(err);
            const outputFile = path.join(options.userConfig.output_directory, "index.html");
            const outputAssets = path.join(options.userConfig.output_directory, "assets");
            fs.writeFile(outputFile, output, {encoding: "utf8"}, err => {
                if (err) {
                    return reject(NICE_ERRORS.COULD_NOT_WRITE_OUTPUT(err, outputFile));
                }
                fs.copy("assets", outputAssets, e => {
                    if (err) {
                        return reject(NICE_ERRORS.COULD_NOT_WRITE_OUTPUT(err, outputAssets));
                    }
                    return resolve(options);
                });
            })
        })
    });
}

function leave(options) {
    /* And shut all our stuff down. Don't close down ghcrawler itself. */
    options.db.close();
    console.log(`Dashboards generated OK in directory '${options.userConfig.output_directory}'.`);
}

function dashboardForEachRepo(options) {
    var dashboardMakers = options.userConfig.github_repositories.map(repo => {
        return runWidgets(options, {limitType: "repo", value: repo})
            .then(assembleDashboard);
    });
    return Promise.all(dashboardMakers)
        .then(function(arrayOfOptions) {
            var optionsBase = Object.assign({}, arrayOfOptions[0]);
            var repo_output_pairs = [];
            arrayOfOptions.forEach(function(o) {
                repo_output_pairs.push({
                    repo: o.repo,
                    outputSlug: o.outputSlug,
                    outputFile: o.outputFile
                })
            })
            delete optionsBase.repo;
            delete optionsBase.outputFile;
            optionsBase.repo_output_pairs = repo_output_pairs;
            return optionsBase;
        });
}

function dashboardForEachContributor(options) {
    var dashboardMakers = options.userConfig.github_repositories.map(repo => {
        return runWidgets(options, {limitType: "repo", value: repo})
            .then(assembleDashboard);
    });
    return Promise.all(dashboardMakers)
        .then(function(arrayOfOptions) {
            var optionsBase = Object.assign({}, arrayOfOptions[0]);
            var repo_output_pairs = [];
            arrayOfOptions.forEach(function(o) {
                repo_output_pairs.push({
                    repo: o.repo,
                    outputSlug: o.outputSlug,
                    outputFile: o.outputFile
                })
            })
            delete optionsBase.repo;
            delete optionsBase.outputFile;
            optionsBase.repo_output_pairs = repo_output_pairs;
            return optionsBase;
        });
}

loadTemplates()
    .then(loadWidgets)
    .then(readConfig)
    .then(connectToDB)
    .then(dashboardForEachRepo)
    .then(dashboardForEachContributor)
    .then(frontPage)
    .then(leave)
    .catch(e => {
        if (db) db.close();
        if (e.isNiceError) {
            console.error("Problem message:")
            console.error(e.message);
        } else {
            console.error("Internal error. (Internal errors are a bug in the code and should be reported.)");
            console.error(e.message);
            console.error(e.stack);
        }
    });