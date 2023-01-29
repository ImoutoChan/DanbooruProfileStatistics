// ==UserScript==
// @name         DanbooruProfileStatistics
// @namespace    damnbooru
// @version      1.3
// @description  Userscript for displaying aggregated tags stats for your favs and uploads
// @author       ImoutoChan
// @match        https://danbooru.donmai.us/profile
// @icon         https://www.google.com/s2/favicons?sz=64&domain=donmai.us
// @downloadURL  https://raw.githubusercontent.com/ImoutoChan/DanbooruProfileStatistics/master/DanbooruProfileStatistics.js
// @updateURL    https://raw.githubusercontent.com/ImoutoChan/DanbooruProfileStatistics/master/DanbooruProfileStatistics.js
// @grant        none
// ==/UserScript==

//////////////////////////////////////////////////////////
//// idb library /////////////////////////////////////////
//////////////////////////////////////////////////////////

const instanceOfAny = (object, constructors) => constructors.some((c) => object instanceof c);

let idbProxyableTypes;
let cursorAdvanceMethods;
// This is a function to prevent it throwing up in node environments.
function getIdbProxyableTypes() {
    return (idbProxyableTypes ||
        (idbProxyableTypes = [
            IDBDatabase,
            IDBObjectStore,
            IDBIndex,
            IDBCursor,
            IDBTransaction,
        ]));
}
// This is a function to prevent it throwing up in node environments.
function getCursorAdvanceMethods() {
    return (cursorAdvanceMethods ||
        (cursorAdvanceMethods = [
            IDBCursor.prototype.advance,
            IDBCursor.prototype.continue,
            IDBCursor.prototype.continuePrimaryKey,
        ]));
}
const cursorRequestMap = new WeakMap();
const transactionDoneMap = new WeakMap();
const transactionStoreNamesMap = new WeakMap();
const transformCache = new WeakMap();
const reverseTransformCache = new WeakMap();
function promisifyRequest(request) {
    const promise = new Promise((resolve, reject) => {
        const unlisten = () => {
            request.removeEventListener('success', success);
            request.removeEventListener('error', error);
        };
        const success = () => {
            resolve(wrap(request.result));
            unlisten();
        };
        const error = () => {
            reject(request.error);
            unlisten();
        };
        request.addEventListener('success', success);
        request.addEventListener('error', error);
    });
    promise
        .then((value) => {
        // Since cursoring reuses the IDBRequest (*sigh*), we cache it for later retrieval
        // (see wrapFunction).
        if (value instanceof IDBCursor) {
            cursorRequestMap.set(value, request);
        }
        // Catching to avoid "Uncaught Promise exceptions"
    })
        .catch(() => { });
    // This mapping exists in reverseTransformCache but doesn't doesn't exist in transformCache. This
    // is because we create many promises from a single IDBRequest.
    reverseTransformCache.set(promise, request);
    return promise;
}
function cacheDonePromiseForTransaction(tx) {
    // Early bail if we've already created a done promise for this transaction.
    if (transactionDoneMap.has(tx))
        return;
    const done = new Promise((resolve, reject) => {
        const unlisten = () => {
            tx.removeEventListener('complete', complete);
            tx.removeEventListener('error', error);
            tx.removeEventListener('abort', error);
        };
        const complete = () => {
            resolve();
            unlisten();
        };
        const error = () => {
            reject(tx.error || new DOMException('AbortError', 'AbortError'));
            unlisten();
        };
        tx.addEventListener('complete', complete);
        tx.addEventListener('error', error);
        tx.addEventListener('abort', error);
    });
    // Cache it for later retrieval.
    transactionDoneMap.set(tx, done);
}
let idbProxyTraps = {
    get(target, prop, receiver) {
        if (target instanceof IDBTransaction) {
            // Special handling for transaction.done.
            if (prop === 'done')
                return transactionDoneMap.get(target);
            // Polyfill for objectStoreNames because of Edge.
            if (prop === 'objectStoreNames') {
                return target.objectStoreNames || transactionStoreNamesMap.get(target);
            }
            // Make tx.store return the only store in the transaction, or undefined if there are many.
            if (prop === 'store') {
                return receiver.objectStoreNames[1]
                    ? undefined
                    : receiver.objectStore(receiver.objectStoreNames[0]);
            }
        }
        // Else transform whatever we get back.
        return wrap(target[prop]);
    },
    set(target, prop, value) {
        target[prop] = value;
        return true;
    },
    has(target, prop) {
        if (target instanceof IDBTransaction &&
            (prop === 'done' || prop === 'store')) {
            return true;
        }
        return prop in target;
    },
};
function replaceTraps(callback) {
    idbProxyTraps = callback(idbProxyTraps);
}
function wrapFunction(func) {
    // Due to expected object equality (which is enforced by the caching in `wrap`), we
    // only create one new func per func.
    // Edge doesn't support objectStoreNames (booo), so we polyfill it here.
    if (func === IDBDatabase.prototype.transaction &&
        !('objectStoreNames' in IDBTransaction.prototype)) {
        return function (storeNames, ...args) {
            const tx = func.call(unwrap(this), storeNames, ...args);
            transactionStoreNamesMap.set(tx, storeNames.sort ? storeNames.sort() : [storeNames]);
            return wrap(tx);
        };
    }
    // Cursor methods are special, as the behaviour is a little more different to standard IDB. In
    // IDB, you advance the cursor and wait for a new 'success' on the IDBRequest that gave you the
    // cursor. It's kinda like a promise that can resolve with many values. That doesn't make sense
    // with real promises, so each advance methods returns a new promise for the cursor object, or
    // undefined if the end of the cursor has been reached.
    if (getCursorAdvanceMethods().includes(func)) {
        return function (...args) {
            // Calling the original function with the proxy as 'this' causes ILLEGAL INVOCATION, so we use
            // the original object.
            func.apply(unwrap(this), args);
            return wrap(cursorRequestMap.get(this));
        };
    }
    return function (...args) {
        // Calling the original function with the proxy as 'this' causes ILLEGAL INVOCATION, so we use
        // the original object.
        return wrap(func.apply(unwrap(this), args));
    };
}
function transformCachableValue(value) {
    if (typeof value === 'function')
        return wrapFunction(value);
    // This doesn't return, it just creates a 'done' promise for the transaction,
    // which is later returned for transaction.done (see idbObjectHandler).
    if (value instanceof IDBTransaction)
        cacheDonePromiseForTransaction(value);
    if (instanceOfAny(value, getIdbProxyableTypes()))
        return new Proxy(value, idbProxyTraps);
    // Return the same value back if we're not going to transform it.
    return value;
}
function wrap(value) {
    // We sometimes generate multiple promises from a single IDBRequest (eg when cursoring), because
    // IDB is weird and a single IDBRequest can yield many responses, so these can't be cached.
    if (value instanceof IDBRequest)
        return promisifyRequest(value);
    // If we've already transformed this value before, reuse the transformed value.
    // This is faster, but it also provides object equality.
    if (transformCache.has(value))
        return transformCache.get(value);
    const newValue = transformCachableValue(value);
    // Not all types are transformed.
    // These may be primitive types, so they can't be WeakMap keys.
    if (newValue !== value) {
        transformCache.set(value, newValue);
        reverseTransformCache.set(newValue, value);
    }
    return newValue;
}
const unwrap = (value) => reverseTransformCache.get(value);

function openDB(name, version, { blocked, upgrade, blocking, terminated } = {}) {
    const request = indexedDB.open(name, version);
    const openPromise = wrap(request);
    if (upgrade) {
        request.addEventListener('upgradeneeded', (event) => {
            upgrade(wrap(request.result), event.oldVersion, event.newVersion, wrap(request.transaction), event);
        });
    }
    if (blocked) {
        request.addEventListener('blocked', (event) => blocked(
        // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
        event.oldVersion, event.newVersion, event));
    }
    openPromise
        .then((db) => {
        if (terminated)
            db.addEventListener('close', () => terminated());
        if (blocking) {
            db.addEventListener('versionchange', (event) => blocking(event.oldVersion, event.newVersion, event));
        }
    })
        .catch(() => { });
    return openPromise;
}
/**
 * Delete a database.
 *
 * @param name Name of the database.
 */
function deleteDB(name, { blocked } = {}) {
    const request = indexedDB.deleteDatabase(name);
    if (blocked) {
        request.addEventListener('blocked', (event) => blocked(
        // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
        event.oldVersion, event));
    }
    return wrap(request).then(() => undefined);
}

const readMethods = ['get', 'getKey', 'getAll', 'getAllKeys', 'count'];
const writeMethods = ['put', 'add', 'delete', 'clear'];
const cachedMethods = new Map();
function getMethod(target, prop) {
    if (!(target instanceof IDBDatabase &&
        !(prop in target) &&
        typeof prop === 'string')) {
        return;
    }
    if (cachedMethods.get(prop))
        return cachedMethods.get(prop);
    const targetFuncName = prop.replace(/FromIndex$/, '');
    const useIndex = prop !== targetFuncName;
    const isWrite = writeMethods.includes(targetFuncName);
    if (
    // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
    !(targetFuncName in (useIndex ? IDBIndex : IDBObjectStore).prototype) ||
        !(isWrite || readMethods.includes(targetFuncName))) {
        return;
    }
    const method = async function (storeName, ...args) {
        // isWrite ? 'readwrite' : undefined gzipps better, but fails in Edge :(
        const tx = this.transaction(storeName, isWrite ? 'readwrite' : 'readonly');
        let target = tx.store;
        if (useIndex)
            target = target.index(args.shift());
        // Must reject if op rejects.
        // If it's a write operation, must reject if tx.done rejects.
        // Must reject with op rejection first.
        // Must resolve with op value.
        // Must handle both promises (no unhandled rejections)
        return (await Promise.all([
            target[targetFuncName](...args),
            isWrite && tx.done,
        ]))[0];
    };
    cachedMethods.set(prop, method);
    return method;
}
replaceTraps((oldTraps) => ({
    ...oldTraps,
    get: (target, prop, receiver) => getMethod(target, prop) || oldTraps.get(target, prop, receiver),
    has: (target, prop) => !!getMethod(target, prop) || oldTraps.has(target, prop),
}));

//////////////////////////////////////////////////////////
//// script code /////////////////////////////////////////
//////////////////////////////////////////////////////////

const db = await openDB('DanbooruProfileStats', 3, {
  upgrade(db, oldVersion, newVersion, transaction, event) {
      if (oldVersion < 2) {
          db.createObjectStore("FavoritePosts", {keyPath: "id"});
      }
      if (oldVersion < 3) {
          db.createObjectStore("UploadedPosts", {keyPath: "id"});
      }
  },
  blocked(currentVersion, blockedVersion, event) {},
  blocking(currentVersion, blockedVersion, event) {},
  terminated() {},
});


const saveFavoritePosts = async (posts) => {
    if (posts.length < 1) {
        return;
    }

    const tx = db.transaction('FavoritePosts', 'readwrite');

    const tasks = posts.map(x => tx.store.put(x));
    await Promise.all(tasks);
};

const saveUploadedPosts = async (posts) => {
    if (posts.length < 1) {
        return;
    }

    const tx = db.transaction('UploadedPosts', 'readwrite');

    const tasks = posts.map(x => tx.store.put(x));
    await Promise.all(tasks);
};

const loadJson = async (url) => {
    const res = await fetch(url);
    return await res.json();
};

const username = document.documentElement.innerHTML.match(/ordfav%3A([^\"]*)/)[1];

const loadFavPosts = async () => {
    const realLastFavPost = document.querySelector('.user-favorites.recent-posts article').getAttribute('data-id');
    const savedLastFavPost = window.localStorage.getItem('DanbooruProfileStats-LastFavoritePost-Id');
    console.log('savedLastFavPost', savedLastFavPost);
    console.log('realLastFavPost', realLastFavPost);

    if (realLastFavPost == savedLastFavPost) {
        console.log('favs is up to date');
        return;
    }
    const pagePlaceholder = '{page}';
    const favLink = 'https://danbooru.donmai.us/posts.json?page=' + pagePlaceholder
        + '&tags=ordfav:' + username
        + '&only=id,tag_string_general,tag_string_character,tag_string_copyright,tag_string_artist,tag_string_meta';

    let loadMore = true;

    let page = 1;
    let lastFavPost = 0;
    do {
        const url = favLink.replace(pagePlaceholder, page);
        console.log('loading', url);
        const favPage = await loadJson(url);

        lastFavPost = lastFavPost === 0 ? favPage[0].id : lastFavPost;
        const pageNotEmpty = favPage.length > 0;
        const lastSavedFavPostOnNotThisPage = savedLastFavPost == null || !favPage.some(x => x.id == savedLastFavPost);

        loadMore = pageNotEmpty && lastSavedFavPostOnNotThisPage;

        await saveFavoritePosts(favPage);
        page++;
    } while (loadMore);

    window.localStorage.setItem('DanbooruProfileStats-LastFavoritePost-Id', lastFavPost);
    console.log('LastFavoritePost', lastFavPost);
    console.log('Check', lastFavPost, realLastFavPost);
};

const loadUploadedPosts = async () => {
    const realLastUploadedPost = document.querySelector('.user-uploads.recent-posts article').getAttribute('data-id');
    const savedLastUploadedPost = window.localStorage.getItem('DanbooruProfileStats-LastUploadedPost-Id');
    console.log('savedLastUploadedPost', savedLastUploadedPost);
    console.log('realLastUploadedPost', realLastUploadedPost);

    if (realLastUploadedPost == savedLastUploadedPost) {
        console.log('uploads is up to date');
        return;
    }

    const pagePlaceholder = '{page}';
    const uploadsLink = 'https://danbooru.donmai.us/posts.json?page=' + pagePlaceholder
        + '&tags=user:' + username
        + '&only=id,tag_string_general,tag_string_character,tag_string_copyright,tag_string_artist,tag_string_meta';

    let loadMore = true;

    let page = 1;
    let lastUploadedPost = 0;
    do {
        const url = uploadsLink.replace(pagePlaceholder, page);
        console.log('loading', url);
        const uploadsPage = await loadJson(url);

        lastUploadedPost = lastUploadedPost === 0 ? uploadsPage[0].id : lastUploadedPost;
        const pageNotEmpty = uploadsPage.length > 0;
        const lastSavedFavPostOnNotThisPage = savedLastUploadedPost == null || !uploadsPage.some(x => x.id == savedLastUploadedPost);

        loadMore = pageNotEmpty && lastSavedFavPostOnNotThisPage;

        await saveUploadedPosts(uploadsPage);
        page++;
    } while (loadMore);

    window.localStorage.setItem('DanbooruProfileStats-LastUploadedPost-Id', lastUploadedPost);
    console.log('LastUploadedPost', lastUploadedPost);
    console.log('Check', lastUploadedPost, realLastUploadedPost);
};

const findMostPopular = async (postSelector, isInFavorite) => {
    const storeName = isInFavorite ? 'FavoritePosts' : 'UploadedPosts';

    const tx = db.transaction(storeName, 'readonly');

    const counts = (await tx.store.getAll())
        .map(x => postSelector(x).split(' '))
        .flat()
        .filter(x => x.length > 0)
        .reduce((counts, currentTag) => {
            if(typeof counts[currentTag] !== "undefined"){
                counts[currentTag]++;
                return counts;
            } else {
                counts[currentTag] = 1;
                return counts;
            }
        }, {});

    let countsArray = [];
    for(var x in counts){
        countsArray.push({ tag: x, count: counts[x] });
    }

    countsArray.sort((a, b) => b.count - a.count);

    return countsArray.slice(0, 40);
};

const showPostsStats = (stats, headerTitle, searchPrefix) => {
    const header = document.createElement('h1');
    header.className = 'stats-header';
    header.innerText = headerTitle;
    document.querySelector('#a-show').appendChild(header);

    const div = document.createElement('div');
    div.className = 'stats-container';
    document.querySelector('#a-show').appendChild(div);

    for(var x in stats){
        const type = stats[x];
        const artitsdiv = document.createElement('div');
        artitsdiv.className = 'stats-type';
        div.appendChild(artitsdiv);

        const typeHeaderDiv = document.createElement('h2');
        typeHeaderDiv.className = 'stats-type-header';
        typeHeaderDiv.innerText = x;
        artitsdiv.appendChild(typeHeaderDiv);

        for(var i in type){
            const tag = type[i];
            const tagdiv = document.createElement('div');
            tagdiv.className = 'stats-type-entry';
            tagdiv.innerHTML = '<a href="/posts?tags=' + searchPrefix + ':' + username + ' ' + tag.tag + '&z=1">&#x1F50D;</a>'
                + '<a href="/posts?tags=' + tag.tag + '&z=1" class="tag ' + x + '">' + tag.tag.replace(/_/g, ' ') + '</a>'
                + '<span class="count">' + tag.count + '</span>';
            artitsdiv.appendChild(tagdiv);
        }
    }
};

//CSS Constants

const CSS = `
.stats-container {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
}
.stats-type-header {
    margin-bottom: 10px;
}
.stats-header {
    margin-bottom: 10px;
    margin-top: 10px;
}
.stats-type-entry {
    margin-bottom: 5px;
    font-size: 14px;
}
.count {
    font-size: 12px;
    color: gray;
}
.artist {
    color: #ff8a8b !important;
}
.copyright {
    color: #c797ff !important;
}
.general {
    color: #009be6 !important;
}
.meta {
    color: #ead084 !important;
}
.character {
    color: #35c64a !important;
}
`;

const appendStyle = (style) => {
  let head = document.head || document.getElementsByTagName('head')[0];
  let styleElement = document.createElement('style');

  styleElement.type = 'text/css';
  if (styleElement.styleSheet){
    styleElement.styleSheet.cssText = style;
  } else {
    styleElement.appendChild(document.createTextNode(style));
  }

  head.appendChild(styleElement);
}

await (async function() {
    'use strict';

    appendStyle(CSS);

    await loadFavPosts();
    await loadUploadedPosts();

    const favPostsStats = {
        artist: (await findMostPopular(x => x.tag_string_artist, true)),
        copyright: (await findMostPopular(x => x.tag_string_copyright, true)),
        character: (await findMostPopular(x => x.tag_string_character, true)),
        general: (await findMostPopular(x => x.tag_string_general, true)),
        meta: (await findMostPopular(x => x.tag_string_meta, true)),
    };
    showPostsStats(favPostsStats, 'Favorites Tags Statistics', 'ordfav');

    const uploadedPostsStats = {
        artist: (await findMostPopular(x => x.tag_string_artist, false)),
        copyright: (await findMostPopular(x => x.tag_string_copyright, false)),
        character: (await findMostPopular(x => x.tag_string_character, false)),
        general: (await findMostPopular(x => x.tag_string_general, false)),
        meta: (await findMostPopular(x => x.tag_string_meta, false)),
    };

    showPostsStats(uploadedPostsStats, 'Uploads Tags Statistics', 'user');
})();



