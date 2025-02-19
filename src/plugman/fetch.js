/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

var fs = require('fs-extra');
var url = require('url');
var semver = require('semver');
var PluginInfoProvider = require('cordova-common').PluginInfoProvider;
var CordovaError = require('cordova-common').CordovaError;
var events = require('cordova-common').events;
var metadata = require('./util/metadata');
var path = require('path');
var pluginSpec = require('../cordova/plugin/plugin_spec_parser');
var fetch = require('cordova-fetch');
var cordovaUtil = require('../cordova/util');

var projectRoot;

// Cache of PluginInfo objects for plugins in search path.
var localPlugins = null;

// possible options: link, subdir, git_ref, client, expected_id
// Returns a promise.
module.exports = fetchPlugin;
function fetchPlugin (plugin_src, plugins_dir, options) {
    // Ensure the containing directory exists.
    fs.ensureDirSync(plugins_dir);
    options = options || {};
    options.subdir = options.subdir || '.';
    options.searchpath = options.searchpath || [];
    if (typeof options.searchpath === 'string') {
        options.searchpath = options.searchpath.split(path.delimiter);
    }

    var pluginInfoProvider = options.pluginInfoProvider || new PluginInfoProvider();

    // clone from git repository
    // @todo Use 'url.URL' constructor instead since 'url.parse' was deprecated since v11.0.0
    var uri = url.parse(plugin_src); // eslint-disable-line

    // If the hash exists, it has the form from npm: http://foo.com/bar#git-ref[:subdir]
    // git-ref can be a commit SHA, a tag, or a branch
    // NB: No leading or trailing slash on the subdir.
    if (uri.hash) {
        var result = uri.hash.match(/^#([^:]*)(?::\/?(.*?)\/?)?$/);
        if (result) {
            if (result[1]) { options.git_ref = result[1]; }
            if (result[2]) { options.subdir = result[2]; }

            // throw error for subdirectories
            if (options.subdir && options.subdir !== '.') {
                return Promise.reject(new CordovaError('Cordova does not support subdirectories'));
            }
        }
    }
    return Promise.resolve().then(function () {
        var plugin_dir = cordovaUtil.fixRelativePath(path.join(plugin_src, options.subdir));
        return Promise.resolve().then(function () {
            // check if it is a local path
            if (fs.existsSync(plugin_dir)) {
                if (!fs.existsSync(path.join(plugin_dir, 'package.json'))) {
                    return Promise.reject(new CordovaError('Invalid Plugin! ' + plugin_dir + ' needs a valid package.json'));
                }

                projectRoot = path.join(plugins_dir, '..');
                // Plugman projects need to go up two directories to reach project root.
                // Plugman projects have an options.projectRoot variable
                if (options.projectRoot) {
                    projectRoot = options.projectRoot;
                }
                return fetch(path.resolve(plugin_dir), projectRoot, options)
                    .then(function (directory) {
                        return {
                            pinfo: pluginInfoProvider.get(directory),
                            fetchJsonSource: {
                                type: 'local',
                                path: directory
                            }
                        };
                    }).catch(function (error) {
                        // something went wrong with cordova-fetch
                        return Promise.reject(new CordovaError(error.message));
                    });
            }
            // If there is no such local path or it's a git URL, it's a plugin id or id@versionspec.
            // First look for it in the local search path (if provided).
            var pinfo = findLocalPlugin(plugin_src, options.searchpath, pluginInfoProvider);
            if (pinfo) {
                events.emit('verbose', 'Found ' + plugin_src + ' at ' + pinfo.dir);
                return {
                    pinfo: pinfo,
                    fetchJsonSource: {
                        type: 'local',
                        path: pinfo.dir
                    }
                };
            } else if (options.noregistry) {
                return Promise.reject(new CordovaError(
                    'Plugin ' + plugin_src + ' not found locally. ' +
                    'Note, plugin registry was disabled by --noregistry flag.'
                ));
            }
            // If not found in local search path, fetch from the registry.
            var parsedSpec = pluginSpec.parse(plugin_src);
            var P;
            var skipCopyingPlugin;
            plugin_dir = path.join(plugins_dir, parsedSpec.id);
            // if the plugin has already been fetched, use it.
            if (fs.existsSync(plugin_dir)) {
                P = Promise.resolve(plugin_dir);
                skipCopyingPlugin = true;
            } else {
                // use cordova-fetch
                projectRoot = path.join(plugins_dir, '..');
                // Plugman projects need to go up two directories to reach project root.
                // Plugman projects have an options.projectRoot variable
                if (options.projectRoot) {
                    projectRoot = options.projectRoot;
                }

                P = fetch(plugin_src, projectRoot, options);
                skipCopyingPlugin = false;
            }
            return P
                .catch(function (error) {
                    var message = 'Failed to fetch plugin ' + plugin_src + ' via registry.' +
                        '\nProbably this is either a connection problem, or plugin spec is incorrect.' +
                        '\nCheck your connection and plugin name/version/URL.' +
                        '\n' + error;
                    return Promise.reject(new CordovaError(message));
                })
                .then(function (dir) {
                    return {
                        pinfo: pluginInfoProvider.get(dir),
                        fetchJsonSource: {
                            type: 'registry',
                            id: plugin_src
                        },
                        skipCopyingPlugin: skipCopyingPlugin
                    };
                });
        }).then(function (result) {
            options.plugin_src_dir = result.pinfo.dir;
            var P;
            if (result.skipCopyingPlugin) {
                P = Promise.resolve(options.plugin_src_dir);
            } else {
                P = Promise.resolve(copyPlugin(result.pinfo, plugins_dir, options.link && result.fetchJsonSource.type === 'local'));
            }
            return P.then(function (dir) {
                result.dest = dir;
                return result;
            });
        });
    }).then(function (result) {
        checkID(options.expected_id, result.pinfo);
        var data = { source: result.fetchJsonSource };
        data.is_top_level = options.is_top_level;
        data.variables = options.variables || {};
        metadata.save_fetch_metadata(plugins_dir, result.pinfo.id, data);
        return result.dest;
    });
}

// Helper function for checking expected plugin IDs against reality.
function checkID (expectedIdAndVersion, pinfo) {
    if (!expectedIdAndVersion) return;

    var parsedSpec = pluginSpec.parse(expectedIdAndVersion);

    if (parsedSpec.id !== pinfo.id) {
        throw new Error('Expected plugin to have ID "' + parsedSpec.id + '" but got "' + pinfo.id + '".');
    }

    if (parsedSpec.version && !semver.satisfies(pinfo.version, parsedSpec.version)) {
        throw new Error('Expected plugin ' + pinfo.id + ' to satisfy version "' + parsedSpec.version + '" but got "' + pinfo.version + '".');
    }
}

// Note, there is no cache invalidation logic for local plugins.
// As of this writing loadLocalPlugins() is never called with different
// search paths and such case would not be handled properly.
function loadLocalPlugins (searchpath, pluginInfoProvider) {
    if (localPlugins) {
        // localPlugins already populated, nothing to do.
        // just in case, make sure it was loaded with the same search path
        if (localPlugins.searchpath.join(path.delimiter) !== searchpath.join(path.delimiter)) {
            var msg =
                'loadLocalPlugins called twice with different search paths.' +
                'Support for this is not implemented.  Using previously cached path.';
            events.emit('warn', msg);
        }
        return;
    }

    // Populate localPlugins object.
    localPlugins = {};
    localPlugins.searchpath = searchpath;
    localPlugins.plugins = {};

    searchpath.forEach(function (dir) {
        var ps = pluginInfoProvider.getAllWithinSearchPath(dir);
        ps.forEach(function (p) {
            var versions = localPlugins.plugins[p.id] || [];
            versions.push(p);
            localPlugins.plugins[p.id] = versions;
        });
    });
}

// If a plugin is fund in local search path, return a PluginInfo for it.
// Ignore plugins that don't satisfy the required version spec.
// If several versions are present in search path, return the latest.
// Examples of accepted plugin_src strings:
//      org.apache.cordova.file
//      org.apache.cordova.file@>=1.2.0
function findLocalPlugin (plugin_src, searchpath, pluginInfoProvider) {
    loadLocalPlugins(searchpath, pluginInfoProvider);
    var parsedSpec = pluginSpec.parse(plugin_src);
    var versionspec = parsedSpec.version || '*';

    var latest = null;
    var versions = localPlugins.plugins[parsedSpec.id];

    if (!versions) return null;

    versions.forEach(function (pinfo) {
        // Ignore versions that don't satisfy the the requested version range.
        // Ignore -dev suffix because latest semver versions doesn't handle it properly (CB-9421)
        if (!semver.satisfies(pinfo.version.replace(/-dev$/, ''), versionspec)) {
            return;
        }
        if (!latest) {
            latest = pinfo;
            return;
        }
        if (semver.gt(pinfo.version, latest.version)) {
            latest = pinfo;
        }
    });
    return latest;
}

// Copy or link a plugin from plugin_dir to plugins_dir/plugin_id.
// if alternative ID of plugin exists in plugins_dir/plugin_id, skip copying
function copyPlugin (pinfo, plugins_dir, link) {
    var plugin_dir = pinfo.dir;
    var dest = path.join(plugins_dir, pinfo.id);

    fs.removeSync(dest);

    if (!link && dest.indexOf(path.resolve(plugin_dir) + path.sep) === 0) {
        events.emit('verbose', 'Copy plugin destination is child of src. Forcing --link mode.');
        link = true;
    }

    if (link) {
        var isRelativePath = plugin_dir.charAt(1) !== ':' && plugin_dir.charAt(0) !== path.sep;
        var fixedPath = isRelativePath ? path.join(path.relative(plugins_dir, process.env.PWD || process.cwd()), plugin_dir) : plugin_dir;
        events.emit('verbose', 'Linking "' + dest + '" => "' + fixedPath + '"');
        fs.symlinkSync(fixedPath, dest, 'junction');
    } else {
        events.emit('verbose', 'Copying plugin "' + plugin_dir + '" => "' + dest + '"');
        fs.copySync(plugin_dir, dest, { dereference: true });
    }
    return dest;
}
