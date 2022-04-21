// Copyright 2022 Google LLC
// 
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// 
//     http://www.apache.org/licenses/LICENSE-2.0
// 
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type { FirebaseOptions } from 'firebase/app';
import type { Header, Rewrite, Redirect } from 'next/dist/lib/load-custom-routes';
import { promises as fsPromises } from 'fs';

import { DeployConfig, getProjectPathFactory } from '../../utils';

const { readFile } = fsPromises;


export type Manifest = {
    distDir?: string,
    basePath?: string,
    headers?: (Header & { regex: string})[],
    redirects?: (Redirect & { regex: string})[],
    rewrites?: (Rewrite & { regex: string})[] | {
        beforeFiles?: (Rewrite & { regex: string})[],
        afterFiles?: (Rewrite & { regex: string})[],
        fallback?: (Rewrite & { regex: string})[],
    },
};

export const firebaseJsonStuff = async (config: DeployConfig, distDir: string) => {
    const getProjectPath = getProjectPathFactory(config);
    const manifestBuffer = await readFile(getProjectPath(distDir, 'routes-manifest.json'));
    const manifest: Manifest = JSON.parse(manifestBuffer.toString());
    const {
        headers: nextJsHeaders=[],
        redirects: nextJsRedirects=[],
        rewrites: nextJsRewrites=[],
    } = manifest;
    const headers = nextJsHeaders.map(({ source, headers }) => ({ source, headers }));
    const redirects = nextJsRedirects
        .filter(({ internal }: any) => !internal)
        .map(({ source, destination, statusCode: type }) => ({ source, destination, type }));
    const nextJsRewritesToUse = Array.isArray(nextJsRewrites) ? nextJsRewrites : nextJsRewrites.beforeFiles || [];
    const rewrites = nextJsRewritesToUse.map(({ source, destination, locale, has }) => {
        // Can we change i18n into Firebase settings?
        if (has) return undefined;
        return { source, destination };
    }).filter(it => it);
    return { headers, rewrites, redirects };
}

export const newFunctionsYaml = (config: DeployConfig) => {
    const { gen, name, region } = config.function!;
    return JSON.stringify({
        endpoints: {
            [name]: {
                platform:  `gcfv${gen}`,
                region: [region],
                labels: {},
                httpsTrigger: {},
                entryPoint: name
            }
        },
        specVersion: 'v1alpha1',
        requiredAPIs: []
    }, null, 2);
};

// TODO dry this out, lots of duplication between the frameworks.
export const newServerJs = (config: DeployConfig, options: FirebaseOptions|null) => {
    const { gen, name, region } = config.function!;
    const conditionalImports = gen === 1 ?
        "const functions = require('firebase-functions');" :
        'const { onRequest } = require(\'firebase-functions/v2/https\');';
    const onRequest = gen === 1 ?
        'functions.https.onRequest(' :
        `onRequest({ region: '${region}' }, `;
    return `${conditionalImports}
const { parse } = require('url');
const next = require('next');
const { join } = require('path');${options ? `
const { initializeApp: initializeAdminApp } = require('firebase-admin/app');
const { getAuth: getAdminAuth } = require('firebase-admin/auth');
const { initializeApp, deleteApp } = require('firebase/app');
const { getAuth, signInWithCustomToken } = require('firebase/auth');
const cookie = require('cookie');
const LRU = require('lru-cache');

const adminApp = initializeAdminApp();
const adminAuth = getAdminAuth(adminApp);
const firebaseConfig = ${JSON.stringify(options)};

// TODO performance tune this
const firebaseAppsLRU = new LRU({
    max: 100,
    ttl: 1_000 * 60 * 5,
    allowStale: true,
    updateAgeOnGet: true,
    dispose: value => {
        deleteApp(value);
    }
});
` : ''}

const nextApp = next({ dev: false, dir: __dirname });
const nextAppPrepare = nextApp.prepare();

exports[${JSON.stringify(name)}] = ${onRequest}async (req, res) => {${options ? `
// TODO figure out why middleware isn't doing this for us
    const cookies = cookie.parse(req.headers.cookie || '');
    let _decodeIdToken;
    const decodeIdToken = () => _decodeIdToken ||= cookies.__session ? adminAuth.verifySessionCookie(cookies.__session, true).catch(() => null) : Promise.resolve(null);
    if (req.url === '/__next/cookie') {
        if (req.body.user) {
            const idToken = req.body.user.idToken;
            const decodedIdTokenFromBody = await adminAuth.verifyIdToken(idToken, true);
            // TODO freshen the session cookie if needed
            //      check for idToken having been freshly minted
            const decodedIdToken = await decodeIdToken();
            if (decodedIdTokenFromBody.uid === decodedIdToken?.uid) {
                res.status(304).end();
            } else {
                // TODO allow this to be configurable
                const expiresIn = 60 * 60 * 24 * 5 * 1000;
                // TODO log the failure
                const cookie = await adminAuth.createSessionCookie(idToken, { expiresIn }).catch(() => null);
                if (cookie) {
                    const options = { maxAge: expiresIn, httpOnly: true, secure: true };
                    res.cookie('__session', cookie, options).status(201).end();
                } else {
                    res.status(401).end();
                }
            }
        } else {
            res.status(204).clearCookie('__session').end();
        }
        return;
    }
    // TODO only go down this path for routes that need it
    const decodedIdToken = await decodeIdToken();
    if (firebaseConfig && decodedIdToken) {
        const { uid } = decodedIdToken;
        let app = firebaseAppsLRU.get(uid);
        if (!app) {
            const random = Math.random().toString(36).split('.')[1];
            const appName = \`authenticated-context:\${uid}:\${random}\`;
            app = initializeApp(firebaseConfig, appName);
            firebaseAppsLRU.set(uid, app);
        }
        const auth = getAuth(app);
        if (auth.currentUser?.uid !== uid) {
            // TODO get custom claims
            //      check in with the Auth team to make sure this is the best way of doing this
            const customToken = await adminAuth.createCustomToken(decodedIdToken.uid);
            await signInWithCustomToken(auth, customToken);
        }
        // TODO can we use a symbol for these or otherwise set them as non iterable
        //      can we drop this and just use useRouter().query.__FIREBASE_APP_NAME?
        // Pass the authenticated firebase app name to getInitialProps, getServerSideProps via req
        // I'd normally reach for a global here, but we need to think about concurrency now with CF3v2
        req['firebaseApp'] = app;
        req['currentUser'] = auth.currentUser;
    }
` : ''}
    const parsedUrl = parse(req.url, true);
    await nextAppPrepare;
    nextApp.getRequestHandler()(req, res, parsedUrl);
});
`;
}

const NODE_VERSION = parseInt(process.versions.node, 10).toString();
const FIREBASE_ADMIN_VERSION = '^10.0.0';
const FIREBASE_FUNCTIONS_VERSION = '^3.16.0';
const COOKIE_VERSION = '^0.4.2';
const LRU_CACHE_VERSION = '^7.3.1';

export const newPackageJson = (packageJson: any) => {
    const newPackageJSON = { ...packageJson };
    newPackageJSON.main = 'server.js';
    // TODO test these with semver, error if already set out of range
    newPackageJSON.dependencies['firebase-admin'] ||= FIREBASE_ADMIN_VERSION;
    newPackageJSON.dependencies['firebase-functions'] ||= FIREBASE_FUNCTIONS_VERSION;
    // TODO if auth-context needed
    newPackageJSON.dependencies['cookie'] ||= COOKIE_VERSION;
    newPackageJSON.dependencies['lru-cache'] ||= LRU_CACHE_VERSION;
    newPackageJSON.engines ||= {};
    newPackageJSON.engines.node ||= NODE_VERSION;
    return JSON.stringify(newPackageJSON, null, 2);
};