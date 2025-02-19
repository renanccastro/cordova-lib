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
 **/

const path = require('path');
const fs = require('fs-extra');
const delay = require('delay');
const globby = require('globby');
const et = require('elementtree');

const HooksRunner = require('../src/hooks/HooksRunner');
const cordovaUtil = require('../src/cordova/util');
const cordova = require('../src/cordova/cordova');
const { tmpDir, testPlatform } = require('../spec/helpers');
const { PluginInfo, ConfigParser } = require('cordova-common');
const { Q_chainmap } = require('../src/util/promise-util');

const tmp = tmpDir('hooks_test');
const project = path.join(tmp, 'project');
const preparedProject = path.join(tmp, 'preparedProject');
const ext = process.platform === 'win32' ? 'bat' : 'sh';
const fixtures = path.join(__dirname, '../spec/cordova/fixtures');

const testPlugin = 'com.plugin.withhooks';
const testPluginFixture = path.join(fixtures, 'plugins', testPlugin);
const testPluginInstalledPath = path.join(project, 'plugins', testPlugin);

describe('HooksRunner', function () {
    let hooksRunner, hookOptions;

    // This prepares a project that we will copy and use for all tests
    beforeAll(function () {
        // Copy project fixture
        const projectFixture = path.join(fixtures, 'projWithHooks');
        fs.copySync(projectFixture, preparedProject);

        // Ensure scripts are executable
        globby.sync(['scripts/**'], {
            cwd: preparedProject, absolute: true
        }).forEach(f => fs.chmodSync(f, 0o755));

        // Add the testing platform and plugin to our project
        process.chdir(preparedProject);
        return cordova.platform('add', testPlatform)
            .then(() => fs.copy(
                testPluginFixture,
                path.join(preparedProject, 'plugins', testPlugin)
            ));
    }, 60 * 1000);

    beforeEach(function () {
        // Reset our test project
        // We are linking node_modules to improve performance
        process.chdir(__dirname); // Avoid EBUSY on Windows
        fs.removeSync(project);
        fs.copySync(preparedProject, project, {
            filter: p => path.basename(p) !== 'node_modules'
        });
        const platformModules = 'platforms/android/cordova/node_modules';
        fs.symlinkSync(path.join(preparedProject, platformModules),
            path.join(project, platformModules), 'junction');

        // Change into our project directory
        process.chdir(project);
        process.env.PWD = project; // this is used by cordovaUtil.isCordova

        hookOptions = {
            projectRoot: project,
            cordova: cordovaUtil.preProcessOptions()
        };

        hooksRunner = new HooksRunner(project);
    });

    afterAll(function () {
        process.chdir(path.join(__dirname, '..')); // Non e2e tests assume CWD is repo root.
        fs.removeSync(tmp);
    });

    it('Test 001 : should throw if provided directory is not a cordova project', function () {
        expect(_ => new HooksRunner(tmp)).toThrow();
    });

    it('Test 002 : should not throw if provided directory is a cordova project', function () {
        expect(_ => new HooksRunner(project)).not.toThrow();
    });

    describe('fire method', function () {
        const test_event = 'before_build';
        const hooksOrderFile = path.join(project, 'hooks_order.txt');

        beforeEach(function () {
            fs.removeSync(hooksOrderFile);
        });

        // helper methods
        function getActualHooksOrder () {
            const fileContents = fs.readFileSync(hooksOrderFile, 'ascii');
            return fileContents.match(/\d+/g).map(Number);
        }

        function checkHooksOrderFile () {
            expect(hooksOrderFile).toExist();

            const hooksOrder = getActualHooksOrder();
            const sortedHooksOrder = hooksOrder.slice(0).sort((a, b) => a - b);
            expect(hooksOrder).toEqual(sortedHooksOrder);
        }

        const BASE_HOOKS = `
            <widget xmlns="http://www.w3.org/ns/widgets">
                <hook type="before_build" src="scripts/appBeforeBuild1.${ext}" />
                <hook type="before_build" src="scripts/appBeforeBuild02.js" />
                <hook type="before_plugin_install" src="scripts/appBeforePluginInstall.js" />
            </widget>
        `;
        const WINDOWS_HOOKS = `
            <widget xmlns="http://www.w3.org/ns/widgets">
                <platform name="windows">
                    <hook type="before_build" src="scripts/windows/appWindowsBeforeBuild.${ext}" />
                    <hook type="before_build" src="scripts/windows/appWindowsBeforeBuild.js" />
                    <hook type="before_plugin_install" src="scripts/windows/appWindowsBeforePluginInstall.js" />
                </platform>
            </widget>
        `;
        const ANDROID_HOOKS = `
            <widget xmlns="http://www.w3.org/ns/widgets">
                <platform name="android">
                    <hook type="before_build" src="scripts/android/appAndroidBeforeBuild.${ext}" />
                    <hook type="before_build" src="scripts/android/appAndroidBeforeBuild.js" />
                    <hook type="before_plugin_install" src="scripts/android/appAndroidBeforePluginInstall.js" />
                </platform>
            </widget>
        `;

        function addHooks (hooksXml, doc) {
            const hooks = et.parse(hooksXml);
            for (const el of hooks.getroot().findall('./*')) {
                doc.getroot().append(el);
            }
        }

        function addHooksToConfig (hooksXml) {
            const config = new ConfigParser(path.join(project, 'config.xml'));
            addHooks(hooksXml, config.doc);
            config.write();
        }

        describe('application hooks', function () {
            it('Test 006 : should execute hook scripts serially from config.xml', function () {
                addHooksToConfig(BASE_HOOKS);

                return hooksRunner.fire(test_event, hookOptions)
                    .then(checkHooksOrderFile);
            });

            it('Test 007 : should execute hook scripts serially from config.xml including platform scripts', function () {
                addHooksToConfig(BASE_HOOKS);
                addHooksToConfig(WINDOWS_HOOKS);

                return hooksRunner.fire(test_event, hookOptions)
                    .then(checkHooksOrderFile);
            });

            it('Test 008 : should filter hook scripts from config.xml by platform', function () {
                addHooksToConfig(BASE_HOOKS);
                addHooksToConfig(WINDOWS_HOOKS);
                addHooksToConfig(ANDROID_HOOKS);
                hookOptions.cordova.platforms = ['android'];

                return hooksRunner.fire(test_event, hookOptions).then(function () {
                    checkHooksOrderFile();

                    const baseScriptResults = [8, 9];
                    const androidPlatformScriptsResults = [14, 15];
                    const expectedResults = baseScriptResults.concat(androidPlatformScriptsResults);
                    expect(getActualHooksOrder()).toEqual(expectedResults);
                });
            });
        });

        describe('plugin hooks', function () {
            const PLUGIN_BASE_HOOKS = `
                <widget xmlns="http://www.w3.org/ns/widgets">
                    <hook type="before_plugin_install" src="scripts/beforeInstall01.js" />
                    <hook type="before_plugin_install" src="scripts/beforeInstall2.js" />
                    <hook type="before_plugin_install" src="scripts/beforeInstall.${ext}" />
                    <hook type="before_plugin_uninstall" src="scripts/beforeUninstall.js" />
                    <hook type="before_build" src="scripts/beforeBuild.js" />
                    <hook type="before_build" src="scripts/beforeBuild.${ext}" />
                </widget>
            `;
            const PLUGIN_WINDOWS_HOOKS = `
                <widget xmlns="http://www.w3.org/ns/widgets">
                    <platform name="windows">
                        <hook type="before_plugin_install" src="scripts/windows/windowsBeforeInstall.js" />
                        <hook type="before_build" src="scripts/windows/windowsBeforeBuild.js" />
                    </platform>
                </widget>
            `;
            const PLUGIN_ANDROID_HOOKS = `
                <widget xmlns="http://www.w3.org/ns/widgets">
                    <platform name="android">
                        <hook type="before_plugin_install" src="scripts/android/androidBeforeInstall.js" />
                        <hook type="before_build" src="scripts/android/androidBeforeBuild.js" />
                    </platform>
                </widget>
            `;

            function addHooksToPlugin (hooksXml) {
                const config = new PluginInfo(testPluginInstalledPath);
                addHooks(hooksXml, config._et);

                const configPath = path.join(testPluginInstalledPath, 'plugin.xml');
                fs.writeFileSync(configPath, config._et.write({ indent: 4 }));
            }

            it('Test 009 : should execute hook scripts serially from plugin.xml', function () {
                addHooksToPlugin(PLUGIN_BASE_HOOKS);

                return hooksRunner.fire(test_event, hookOptions)
                    .then(checkHooksOrderFile);
            });

            it('Test 010 : should execute hook scripts serially from plugin.xml including platform scripts', function () {
                addHooksToPlugin(PLUGIN_BASE_HOOKS);
                addHooksToPlugin(PLUGIN_WINDOWS_HOOKS);

                return hooksRunner.fire(test_event, hookOptions)
                    .then(checkHooksOrderFile);
            });

            it('Test 011 : should filter hook scripts from plugin.xml by platform', function () {
                // Make scripts executable
                globby.sync('scripts/**', { cwd: testPluginInstalledPath, absolute: true })
                    .forEach(f => fs.chmodSync(f, 0o755));

                addHooksToPlugin(PLUGIN_BASE_HOOKS);
                addHooksToPlugin(PLUGIN_WINDOWS_HOOKS);
                addHooksToPlugin(PLUGIN_ANDROID_HOOKS);
                hookOptions.cordova.platforms = ['android'];

                return hooksRunner.fire(test_event, hookOptions).then(function () {
                    checkHooksOrderFile();

                    const baseScriptResults = [21, 22];
                    const androidPlatformScriptsResults = [26];
                    const expectedResults = baseScriptResults.concat(androidPlatformScriptsResults);
                    expect(getActualHooksOrder()).toEqual(expectedResults);
                });
            });

            it('Test 013 : should not execute the designated hook when --nohooks option specifies the exact hook name', function () {
                hookOptions.nohooks = ['before_build'];

                return hooksRunner.fire(test_event, hookOptions).then(function (msg) {
                    expect(msg).toBeDefined();
                    expect(msg).toBe('hook before_build is disabled.');
                });
            });

            it('Test 014 : should not execute a set of matched hooks when --nohooks option specifies the hook pattern.', function () {
                var test_events = ['before_build', 'after_plugin_add', 'before_platform_rm', 'before_prepare'];
                hookOptions.nohooks = ['before*'];

                return Q_chainmap(test_events, e => {
                    return hooksRunner.fire(e, hookOptions).then(msg => {
                        if (e === 'after_plugin_add') {
                            expect(msg).toBeUndefined();
                        } else {
                            expect(msg).toBeDefined();
                            expect(msg).toBe(`hook ${e} is disabled.`);
                        }
                    });
                });
            });

            it('Test 015 : should not execute all hooks when --nohooks option specifies .', function () {
                var test_events = ['before_build', 'after_plugin_add', 'before_platform_rm', 'before_prepare'];
                hookOptions.nohooks = ['.'];

                return Q_chainmap(test_events, e => {
                    return hooksRunner.fire(e, hookOptions).then(msg => {
                        expect(msg).toBeDefined();
                        expect(msg).toBe(`hook ${e} is disabled.`);
                    });
                });
            });
        });

        describe('module-level hooks (event handlers)', function () {
            var handler = jasmine.createSpy().and.returnValue(Promise.resolve());

            afterEach(function () {
                cordova.removeAllListeners(test_event);
                handler.calls.reset();
            });

            it('Test 016 : should fire handlers using cordova.on', function () {
                cordova.on(test_event, handler);
                return hooksRunner.fire(test_event, hookOptions).then(function () {
                    expect(handler).toHaveBeenCalled();
                });
            });

            it('Test 017 : should pass the project root folder as parameter into the module-level handlers', function () {
                cordova.on(test_event, handler);
                return hooksRunner.fire(test_event, hookOptions).then(function () {
                    expect(handler).toHaveBeenCalledWith(hookOptions);
                });
            });

            it('Test 018 : should be able to stop listening to events using cordova.off', function () {
                cordova.on(test_event, handler);
                cordova.off(test_event, handler);
                return hooksRunner.fire(test_event, hookOptions).then(function () {
                    expect(handler).not.toHaveBeenCalled();
                });
            });

            it('Test 019 : should execute event listeners serially', function () {
                const order = [];
                // Delay 100 ms here to check that h2 is not executed until after
                // the promise returned by h1 is resolved.
                const h1 = _ => delay(100).then(_ => order.push(1));
                const h2 = _ => Promise.resolve().then(_ => order.push(2));

                cordova.on(test_event, h1);
                cordova.on(test_event, h2);

                return hooksRunner.fire(test_event, hookOptions)
                    .then(_ => expect(order).toEqual([1, 2]));
            });

            it('Test 021 : should pass data object that fire calls into async handlers', function () {
                var asyncHandler = function (opts) {
                    expect(opts).toEqual(hookOptions);
                    return Promise.resolve();
                };
                cordova.on(test_event, asyncHandler);
                return hooksRunner.fire(test_event, hookOptions);
            });

            it('Test 022 : should pass data object that fire calls into sync handlers', function () {
                var syncHandler = function (opts) {
                    expect(opts).toEqual(hookOptions);
                };
                cordova.on(test_event, syncHandler);
                return hooksRunner.fire(test_event, hookOptions);
            });

            it('Test 023 : should error if any hook fails', function () {
                const FAIL_HOOK = `
                    <widget xmlns="http://www.w3.org/ns/widgets">
                        <hook type="fail" src="scripts/fail.js" />
                    </widget>
                `;
                addHooksToConfig(FAIL_HOOK);

                return hooksRunner.fire('fail', hookOptions).then(function () {
                    fail('Expected promise to be rejected');
                }, function (err) {
                    expect(err).toEqual(jasmine.any(Error));
                });
            });
        });

        it('Test 024 : should not error if the hook is unrecognized', function () {
            return hooksRunner.fire('CLEAN YOUR SHORTS GODDAMNIT LIKE A BIG BOY!', hookOptions);
        });
    });
});
