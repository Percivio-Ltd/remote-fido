#!/usr/bin/env node
// Reproducible minimal Xcode wrapper. Uses Apple's installed Safari extension
// point; no browser entitlements, certificates, or profile spoofing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(repo, 'build/ios');
if (!fs.realpathSync(repo).startsWith('/Volumes/BigStore/')) throw new Error('Build output must be on mounted BigStore');
fs.accessSync('/Volumes/BigStore', fs.constants.W_OK);
fs.mkdirSync(path.join(out, 'Resources'), {recursive: true});
fs.mkdirSync(path.join(out, 'RemoteFIDO.xcodeproj'), {recursive: true});
const source = path.join(repo, 'v2/approver-extension');
const files = ['app.html', 'app.css', 'app.js', 'ceremony.js', 'request.js', 'worker.js'];
for (const file of files) fs.copyFileSync(path.join(source, file), path.join(out, 'Resources', file));
for (const file of ['launch.html', 'launch.js']) fs.copyFileSync(path.join(repo, 'v2/ios', file), path.join(out, 'Resources', file));
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json')));
delete manifest.key; manifest.background = {scripts: ['worker.js'], type: 'module'};
manifest.action.default_popup = 'launch.html';
fs.writeFileSync(path.join(out, 'Resources/manifest.json'), JSON.stringify(manifest, null, 2));
for (const file of ['RemoteFIDOApp.swift', 'SafariWebExtensionHandler.swift']) fs.copyFileSync(path.join(repo, 'v2/ios', file), path.join(out, file));
const escape = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function xml(value) {
  if (Array.isArray(value)) return `<array>${value.map(xml).join('')}</array>`;
  if (value && typeof value === 'object') return `<dict>${Object.entries(value).map(([k, v]) => `<key>${escape(k)}</key>${xml(v)}`).join('')}</dict>`;
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  return `<string>${escape(value)}</string>`;
}
const plist = v => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${xml(v)}</plist>`;
fs.writeFileSync(path.join(out, 'Extension-Info.plist'), plist({CFBundleDisplayName: 'Remote FIDO', CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
  CFBundleExecutable: '$(EXECUTABLE_NAME)', CFBundleName: '$(PRODUCT_NAME)', CFBundlePackageType: 'XPC!', CFBundleShortVersionString: '0.5.0', CFBundleVersion: '1',
  NSExtension: {NSExtensionPointIdentifier: 'com.apple.Safari.web-extension', NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).SafariWebExtensionHandler'}}));
const objects = {}; const id = name => crypto.createHash('sha256').update(name).digest('hex').slice(0, 24).toUpperCase();
function object(name, value) { objects[id(name)] = value; return id(name); }
const file = (name, type, filePath = name, tree = '<group>') => object(name, {isa: 'PBXFileReference', lastKnownFileType: type, path: filePath, sourceTree: tree});
const appSwift = file('RemoteFIDOApp.swift', 'sourcecode.swift');
const extSwift = file('SafariWebExtensionHandler.swift', 'sourcecode.swift');
const appProduct = file('RemoteFIDO.app', 'wrapper.application', 'RemoteFIDO.app', 'BUILT_PRODUCTS_DIR');
const extProduct = file('RemoteFIDOExtension.appex', 'wrapper.app-extension', 'RemoteFIDOExtension.appex', 'BUILT_PRODUCTS_DIR');
const resources = [...files, 'launch.html', 'launch.js', 'manifest.json'].map(name => file(`resource-${name}`, name.endsWith('.json') ? 'text.json' : 'text', `Resources/${name}`));
const buildFile = (name, ref, settings) => object(name, {isa: 'PBXBuildFile', fileRef: ref, ...(settings ? {settings} : {})});
const phase = (name, isa, files, extra = {}) => object(name, {isa, buildActionMask: 2147483647, files, runOnlyForDeploymentPostprocessing: 0, ...extra});
const appSources = phase('app-sources', 'PBXSourcesBuildPhase', [buildFile('app-swift', appSwift)]);
const extSources = phase('ext-sources', 'PBXSourcesBuildPhase', [buildFile('ext-swift', extSwift)]);
const extResources = phase('ext-resources', 'PBXResourcesBuildPhase', resources.map((r, i) => buildFile(`res-${i}`, r)));
const embed = phase('embed-extension', 'PBXCopyFilesBuildPhase', [buildFile('embed', extProduct, {ATTRIBUTES: ['RemoveHeadersOnCopy']})], {dstPath: '', dstSubfolderSpec: 13, name: 'Embed App Extensions'});
const settings = {SDKROOT: 'iphoneos', IPHONEOS_DEPLOYMENT_TARGET: '17.0', SWIFT_VERSION: '5.0', TARGETED_DEVICE_FAMILY: '1,2',
  CODE_SIGN_STYLE: 'Automatic', CURRENT_PROJECT_VERSION: '1', MARKETING_VERSION: '0.5.0', ENABLE_USER_SCRIPT_SANDBOXING: 'YES'};
function configs(name, extra) {
  return object(`${name}-configs`, {isa: 'XCConfigurationList', defaultConfigurationIsVisible: 0, defaultConfigurationName: 'Debug',
    buildConfigurations: ['Debug', 'Release'].map(mode => object(`${name}-${mode}`, {isa: 'XCBuildConfiguration', name: mode,
      buildSettings: {...settings, SWIFT_OPTIMIZATION_LEVEL: mode === 'Debug' ? '-Onone' : '-O', ...extra}}))});
}
const projectConfigs = configs('project', {});
const appConfigs = configs('app', {PRODUCT_NAME: 'RemoteFIDO', PRODUCT_BUNDLE_IDENTIFIER: 'de.lytiq.RemoteFIDO', GENERATE_INFOPLIST_FILE: 'YES',
  INFOPLIST_KEY_UIApplicationSceneManifest_Generation: 'YES', INFOPLIST_KEY_UILaunchScreen_Generation: 'YES', INFOPLIST_KEY_CFBundleDisplayName: 'Remote FIDO',
  INFOPLIST_KEY_UISupportedInterfaceOrientations: 'UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight'});
const extConfigs = configs('extension', {PRODUCT_NAME: 'RemoteFIDOExtension', PRODUCT_BUNDLE_IDENTIFIER: 'de.lytiq.RemoteFIDO.Extension',
  APPLICATION_EXTENSION_API_ONLY: 'YES', SKIP_INSTALL: 'YES', INFOPLIST_FILE: 'Extension-Info.plist', OTHER_LDFLAGS: ['-framework', 'SafariServices']});
const extTarget = object('extension-target', {isa: 'PBXNativeTarget', name: 'RemoteFIDOExtension', productName: 'RemoteFIDOExtension',
  productReference: extProduct, productType: 'com.apple.product-type.app-extension', buildConfigurationList: extConfigs,
  buildPhases: [extSources, extResources], buildRules: [], dependencies: []});
const proxy = object('extension-proxy', {isa: 'PBXContainerItemProxy', containerPortal: id('project'), proxyType: 1, remoteGlobalIDString: extTarget, remoteInfo: 'RemoteFIDOExtension'});
const dependency = object('extension-dependency', {isa: 'PBXTargetDependency', target: extTarget, targetProxy: proxy});
const appTarget = object('app-target', {isa: 'PBXNativeTarget', name: 'RemoteFIDO', productName: 'RemoteFIDO', productReference: appProduct,
  productType: 'com.apple.product-type.application', buildConfigurationList: appConfigs, buildPhases: [appSources, embed], buildRules: [], dependencies: [dependency]});
const products = object('products', {isa: 'PBXGroup', name: 'Products', children: [appProduct, extProduct], sourceTree: '<group>'});
const group = object('main-group', {isa: 'PBXGroup', children: [appSwift, extSwift, ...resources, products], sourceTree: '<group>'});
const project = object('project', {isa: 'PBXProject', attributes: {LastUpgradeCheck: '2600'}, buildConfigurationList: projectConfigs, compatibilityVersion: 'Xcode 14.0',
  developmentRegion: 'en', hasScannedForEncodings: 0, knownRegions: ['en', 'Base'], mainGroup: group, productRefGroup: products,
  projectDirPath: '', projectRoot: '', targets: [appTarget, extTarget]});
fs.writeFileSync(path.join(out, 'RemoteFIDO.xcodeproj/project.pbxproj'), plist({archiveVersion: 1, classes: {}, objectVersion: 56, objects, rootObject: project}));
console.log(`Generated ${out}/RemoteFIDO.xcodeproj. Signing and hardware acceptance remain separate.`);
if (process.argv.includes('--build')) for (const sdk of ['iphonesimulator', 'iphoneos']) {
  execFileSync('xcodebuild', ['-project', path.join(out, 'RemoteFIDO.xcodeproj'), '-scheme', 'RemoteFIDO', '-configuration', 'Debug',
    '-sdk', sdk, '-destination', sdk === 'iphoneos' ? 'generic/platform=iOS' : 'generic/platform=iOS Simulator',
    '-derivedDataPath', path.join(out, `Derived-${sdk}`), 'CODE_SIGNING_ALLOWED=NO', 'build'], {stdio: 'inherit'});
}
