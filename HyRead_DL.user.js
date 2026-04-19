// ==UserScript==
// @name         HyRead_DL
// @namespace    https://qinlili.bid
// @version      0.31.0
// @description  完善各种体验
// @author       NBXX & AI
// @match        https://service.ebook.hyread.com.tw/ebookservice/epubreader/hyread/v3/openbook2.jsp?*
// @icon         https://webcdn2.ebook.hyread.com.tw/Template/store/favicon/favicon.ico
// @grant        none
// @run-at       document-start
// @require      https://lib.baomitu.com/jquery/3.6.0/jquery.min.js#sha512-894YE6QWD5I59HgZOGReFYm4dnWc1Qt5NtvYSaNcOP+u1T9qYdvdihz0PPSiiqn/+/3e7Jo4EaG7TubfWGUrMQ==
// @require      https://lib.baomitu.com/jszip/3.10.1/jszip.min.js#sha512-XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg==
// @require      https://cdn.jsdelivr.net/npm/js-base64@3.7.2/base64.min.js
// @require      https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js
// @license      MPL2.0
// ==/UserScript==

(function () {
    'use strict';

    const MAX_CONCURRENT = 8;
    const GAP_PROBE_LIMIT = 80;
    const PAGE_PROBE_LIMIT = 512;
    const OPF_NS = "http://www.idpf.org/2007/opf";
    const DC_NS = "http://purl.org/dc/elements/1.1/";
    const BLOCK_TAGS = new Set([
        "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt", "fieldset",
        "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
        "header", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody",
        "td", "tfoot", "th", "thead", "tr", "ul"
    ]);

    let capturedCryptoKey = null;
    let rawKeyBuffer = null;
    let assetId = null;
    let isDownloading = false;

    let bookInfo = { title: "HyRead_Book", pubDate: "", isbn: "" };
    let bookProfile = {
        layout: "",
        isComic: false,
        isNovel: false,
        isFixedLayout: false,
        navPath: "",
        pageProgressionDirection: "rtl"
    };
    let officialOPF = "";
    let officialContainer = "";
    let opfPath = "OEBPS/content.opf";
    let manifestItems = [];
    let officialSpine = [];
    let officialManifestMeta = new Map();
    let officialSpineEntries = [];
    let officialIdToHref = new Map();
    let fixedLayoutPagesCache = new Map();
    let fixedLayoutPagesPromiseCache = new Map();
    let assetExistenceCache = new Map();

    // --- 工具函数 ---
    function buf2hex(buffer) {
        return Array.prototype.map.call(new Uint8Array(buffer), x => ('00' + x.toString(16)).slice(-2)).join('');
    }
    function escapeXml(unsafe) {
        return String(unsafe ?? "").replace(/[<>&'"]/g, c => {
            switch (c) { case '<': return '&lt;'; case '>': return '&gt;'; case '&': return '&amp;'; case '\'': return '&apos;'; case '"': return '&quot;'; }
        });
    }
    function getElementsByLocalName(root, localName) {
        if (!root || typeof root.getElementsByTagNameNS !== "function") return [];
        return Array.from(root.getElementsByTagNameNS("*", localName));
    }
    function findDirectChildByLocalName(parent, localName) {
        return Array.from(parent?.children || []).find(el => (el.localName || "").toLowerCase() === localName.toLowerCase()) || null;
    }
    function normalizeDateValue(value) {
        let match = String(value || "").trim().match(/(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : "";
    }
    function normalizeIsbnCandidate(value) {
        return String(value || "")
            .replace(/urn:isbn:/ig, "")
            .replace(/isbn(?:-1[03])?:?/ig, "")
            .replace(/[^0-9Xx]/g, "")
            .toUpperCase();
    }
    function compareNumericText(a, b) {
        if (a.length !== b.length) return a.length - b.length;
        try {
            let aNum = BigInt(a || "0");
            let bNum = BigInt(b || "0");
            if (aNum < bNum) return -1;
            if (aNum > bNum) return 1;
        } catch (e) {}
        return a.localeCompare(b);
    }
    function extractPreferredPubDate(opfDoc) {
        let dcDates = getElementsByLocalName(opfDoc, "date")
            .map(el => normalizeDateValue(el.textContent))
            .filter(Boolean)
            .sort();
        if (dcDates.length) return dcDates[dcDates.length - 1];

        let modifiedDates = Array.from(opfDoc.querySelectorAll("*[property='dcterms:modified']"))
            .map(el => normalizeDateValue(el.textContent))
            .filter(Boolean)
            .sort();
        return modifiedDates[modifiedDates.length - 1] || "";
    }
    function extractPreferredIsbn(opfDoc) {
        let candidates = [];
        getElementsByLocalName(opfDoc, "identifier").forEach(el => {
            let text = (el.textContent || "").trim();
            if (!text || /uuid/i.test(text)) return;
            let normalizedWhole = normalizeIsbnCandidate(text);
            if (/^(\d{13}|\d{9}[\dX]|\d{10})$/.test(normalizedWhole)) candidates.push(normalizedWhole);
            let matches = text.match(/(?:urn:isbn:)?(?:isbn(?:-1[03])?:?\s*)?[0-9Xx][0-9Xx\-\s]{8,18}/ig) || [];
            matches.forEach(match => {
                let normalized = normalizeIsbnCandidate(match);
                if (/^(\d{13}|\d{9}[\dX]|\d{10})$/.test(normalized)) candidates.push(normalized);
            });
        });
        if (!candidates.length) return "";
        candidates.sort((a, b) => compareNumericText(a.replace(/\D/g, ""), b.replace(/\D/g, "")) || a.localeCompare(b));
        return candidates[candidates.length - 1];
    }
    function formatMetadataTimestamp(dateOnly) {
        return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly || "") ? `${dateOnly}T00:00:00Z` : "";
    }
    function parseDateParts(dateOnly) {
        let match = String(dateOnly || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return null;
        return {
            year: match[1],
            month: String(Number(match[2])),
            day: String(Number(match[3]))
        };
    }
    function buildPrimaryIdentifier() {
        return bookInfo.isbn ? `urn:isbn:${bookInfo.isbn}` : `urn:uuid:${assetId || Date.now()}`;
    }
    function buildGeneratedMetadataXml(extraLines = []) {
        let lines = [
            `    <dc:title>${escapeXml(bookInfo.title)}</dc:title>`,
            `    <dc:identifier id="uid">${escapeXml(buildPrimaryIdentifier())}</dc:identifier>`
        ];
        if (bookInfo.isbn) lines.push(`    <dc:identifier>${escapeXml(bookInfo.isbn)}</dc:identifier>`);
        lines.push(`    <dc:language>zh-TW</dc:language>`);
        if (bookInfo.pubDate) {
            lines.push(`    <dc:date>${escapeXml(bookInfo.pubDate)}</dc:date>`);
            lines.push(`    <meta property="dcterms:modified">${escapeXml(formatMetadataTimestamp(bookInfo.pubDate))}</meta>`);
        }
        return [...lines, ...extraLines].join("\n");
    }
    function applyPreferredMetadataToOpf(opfDoc) {
        let metadataEl = findDirectChildByLocalName(opfDoc.documentElement, "metadata");
        if (!metadataEl) return;

        if (bookInfo.title) {
            let titleEl = findDirectChildByLocalName(metadataEl, "title");
            if (!titleEl) {
                titleEl = opfDoc.createElementNS(DC_NS, "dc:title");
                metadataEl.insertBefore(titleEl, metadataEl.firstChild);
            }
            titleEl.textContent = bookInfo.title;
        }

        if (bookInfo.pubDate) {
            let dateEl = findDirectChildByLocalName(metadataEl, "date");
            if (!dateEl) {
                dateEl = opfDoc.createElementNS(DC_NS, "dc:date");
                metadataEl.appendChild(dateEl);
            }
            dateEl.textContent = bookInfo.pubDate;
        }

        if (bookInfo.isbn) {
            let hasIsbn = getElementsByLocalName(metadataEl, "identifier").some(el => normalizeIsbnCandidate(el.textContent) === bookInfo.isbn);
            if (!hasIsbn) {
                let isbnEl = opfDoc.createElementNS(DC_NS, "dc:identifier");
                isbnEl.textContent = `ISBN: ${bookInfo.isbn}`;
                metadataEl.appendChild(isbnEl);
            }
        }
    }
    function buildComicInfoXml(pageCount) {
        let parts = parseDateParts(bookInfo.pubDate);
        let lines = [
            `<?xml version="1.0" encoding="utf-8"?>`,
            `<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">`,
            `  <Title>${escapeXml(bookInfo.title)}</Title>`,
            `  <PageCount>${pageCount}</PageCount>`
        ];
        if (parts) {
            lines.push(`  <Year>${escapeXml(parts.year)}</Year>`);
            lines.push(`  <Month>${escapeXml(parts.month)}</Month>`);
            lines.push(`  <Day>${escapeXml(parts.day)}</Day>`);
        }
        if (bookInfo.isbn) lines.push(`  <ISBN>${escapeXml(bookInfo.isbn)}</ISBN>`);
        lines.push(`</ComicInfo>`);
        return lines.join("\n");
    }
    function applyPdfMetadata(pdf) {
        if (!pdf) return;
        let keywords = [];
        if (bookInfo.isbn) keywords.push(`ISBN:${bookInfo.isbn}`);
        if (bookInfo.pubDate) keywords.push(`Published:${bookInfo.pubDate}`);
        let props = {
            title: bookInfo.title || "HyRead Book",
            subject: bookProfile.isNovel ? "Novel export" : "Page export",
            creator: "HyRead电子书随心下",
            keywords: keywords.join(", ")
        };
        if (typeof pdf.setDocumentProperties === "function") pdf.setDocumentProperties(props);
        else if (typeof pdf.setProperties === "function") pdf.setProperties(props);
        if (bookInfo.pubDate && typeof pdf.setCreationDate === "function") {
            try { pdf.setCreationDate(new Date(`${bookInfo.pubDate}T00:00:00Z`)); } catch (e) {}
        }
    }
    function getFixedLayoutCacheKey() {
        return String(assetId || `${opfPath}|${bookInfo.title || "hyread"}`);
    }
    function cloneFixedLayoutPages(pages) {
        return Array.isArray(pages) ? pages.map(page => ({ ...page })) : [];
    }
    function getMediaType(fname) {
        if (/\.xhtml$/i.test(fname)) return "application/xhtml+xml";
        if (/\.html?$/i.test(fname)) return "text/html";
        if (/\.css$/i.test(fname)) return "text/css";
        if (/\.ncx$/i.test(fname)) return "application/x-dtbncx+xml";
        if (/\.xml$/i.test(fname)) return "application/xml";
        if (/\.jpe?g$/i.test(fname)) return "image/jpeg";
        if (/\.png$/i.test(fname)) return "image/png";
        if (/\.gif$/i.test(fname)) return "image/gif";
        if (/\.svg$/i.test(fname)) return "image/svg+xml";
        if (/\.woff2?$/i.test(fname)) return "font/woff";
        if (/\.otf$/i.test(fname)) return "font/otf";
        if (/\.ttf$/i.test(fname)) return "font/ttf";
        return "application/octet-stream";
    }
    function isTextResource(relPath) {
        return /\.(xhtml|html|htm|xml|ncx|opf)$/i.test(relPath);
    }
    function isTextDocument(relPath) {
        return /\.(xhtml|html|htm)$/i.test(relPath);
    }
    function getBaseName(relPath) {
        return relPath.split("/").pop().split("#")[0].toLowerCase();
    }
    function isNavigationDocument(relPath) {
        return /^(nav|toc|navigation-documents?)\.xhtml?$/.test(getBaseName(relPath));
    }
    function isPrimaryTextDocument(relPath) {
        return isTextDocument(relPath) && !isNavigationDocument(relPath);
    }
    function parseNumberedTextPath(relPath) {
        let clean = relPath.split("#")[0].split("?")[0];
        if (!/\.(xhtml|html|htm)$/i.test(clean)) return null;
        let match = clean.match(/^(.*?)(\d+)(\.(?:xhtml|html|htm))$/i);
        if (!match) return null;
        return {
            path: clean,
            prefix: match[1],
            num: Number(match[2]),
            width: match[2].length,
            ext: match[3].toLowerCase(),
            groupKey: `${match[1]}|${match[3].toLowerCase()}`
        };
    }
    function parseNumberedImagePath(relPath) {
        let clean = relPath.split("#")[0].split("?")[0];
        if (!/\.(?:jpe?g|png|gif|webp)$/i.test(clean)) return null;
        let match = clean.match(/^(.*?)(\d+)(\.(?:jpe?g|png|gif|webp))$/i);
        if (!match) return null;
        return {
            path: clean,
            prefix: match[1],
            num: Number(match[2]),
            width: match[2].length,
            ext: match[3].toLowerCase(),
            groupKey: `${match[1]}|${match[3].toLowerCase()}`
        };
    }
    function compareDocumentPaths(a, b) {
        let aInfo = parseNumberedTextPath(a);
        let bInfo = parseNumberedTextPath(b);
        if (aInfo && bInfo) {
            if (aInfo.groupKey !== bInfo.groupKey) return aInfo.groupKey.localeCompare(bInfo.groupKey);
            if (aInfo.num !== bInfo.num) return aInfo.num - bInfo.num;
        }
        return a.localeCompare(b);
    }
    function compareImagePaths(a, b) {
        let aInfo = parseNumberedImagePath(a);
        let bInfo = parseNumberedImagePath(b);
        if (aInfo && bInfo) {
            if (aInfo.groupKey !== bInfo.groupKey) return aInfo.groupKey.localeCompare(bInfo.groupKey);
            if (aInfo.num !== bInfo.num) return aInfo.num - bInfo.num;
        }
        return a.localeCompare(b);
    }
    function buildNumberedPath(info, num) {
        return `${info.prefix}${String(num).padStart(info.width, "0")}${info.ext}`;
    }
    function detectBookProfile(opfDoc) {
        let layout = (opfDoc.querySelector("*[property='rendition:layout']")?.textContent || "").trim().toLowerCase();
        let navItem = Array.from(opfDoc.querySelectorAll("manifest > item")).find(item => /\bnav\b/i.test(item.getAttribute("properties") || ""));
        return {
            layout,
            isFixedLayout: layout === "pre-paginated",
            isComic: false,
            isNovel: layout === "reflowable",
            navPath: navItem ? (navItem.getAttribute("href") || "") : "",
            pageProgressionDirection: opfDoc.querySelector("spine")?.getAttribute("page-progression-direction") || "rtl"
        };
    }
    function normalizeWhitespace(text) {
        return text
            .replace(/\u00a0/g, " ")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n[ \t]+/g, "\n")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }
    function extractReadableText(markup) {
        let doc = new DOMParser().parseFromString(markup, "text/html");
        if (!doc.body) return "";
        doc.querySelectorAll("script,style,noscript,svg,img,picture,source,audio,video,canvas,iframe").forEach(el => el.remove());
        doc.querySelectorAll("rt,rp").forEach(el => el.remove());

        let parts = [];
        function walk(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                let text = node.textContent || "";
                if (text.trim()) parts.push(text);
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            let tag = node.tagName.toLowerCase();
            if (tag === "br") {
                parts.push("\n");
                return;
            }
            let isBlock = BLOCK_TAGS.has(tag);
            if (isBlock && parts.length && !/\n$/.test(parts[parts.length - 1])) parts.push("\n");
            node.childNodes.forEach(child => walk(child));
            if (isBlock) parts.push("\n");
        }

        walk(doc.body);
        return normalizeWhitespace(parts.join(""));
    }
    function buildOrderedTextPaths(fileMap, dynamicSpine) {
        let textPaths = Array.from(fileMap.keys()).filter(isPrimaryTextDocument);
        let textSet = new Set(textPaths);
        let ordered = [];
        let seen = new Set();

        function add(path) {
            if (textSet.has(path) && !seen.has(path)) {
                ordered.push(path);
                seen.add(path);
            }
        }

        dynamicSpine.forEach(add);
        officialSpine.forEach(add);

        let leftovers = textPaths.filter(path => !seen.has(path)).sort(compareDocumentPaths);
        leftovers.forEach(path => {
            let info = parseNumberedTextPath(path);
            if (!info) {
                ordered.push(path);
                seen.add(path);
                return;
            }

            let insertAt = -1;
            for (let i = ordered.length - 1; i >= 0; i--) {
                let existing = parseNumberedTextPath(ordered[i]);
                if (existing && existing.groupKey === info.groupKey && existing.num < info.num) {
                    insertAt = i + 1;
                    break;
                }
            }
            if (insertAt === -1) {
                for (let i = 0; i < ordered.length; i++) {
                    let existing = parseNumberedTextPath(ordered[i]);
                    if (existing && existing.groupKey === info.groupKey && existing.num > info.num) {
                        insertAt = i;
                        break;
                    }
                }
            }
            if (insertAt === -1) ordered.push(path);
            else ordered.splice(insertAt, 0, path);
            seen.add(path);
        });

        return ordered;
    }
    function buildNovelPatchedOpf(fileMap, orderedTextPaths) {
        let opfDoc = new DOMParser().parseFromString(officialOPF, "application/xml");
        if (opfDoc.querySelector("parsererror")) opfDoc = new DOMParser().parseFromString(officialOPF, "text/xml");
        let manifestEl = opfDoc.querySelector("manifest");
        let spineEl = opfDoc.querySelector("spine");
        if (!manifestEl || !spineEl) throw new Error("官方 OPF 缺少 manifest/spine");

        let manifestByHref = new Map();
        let usedIds = new Set();
        manifestEl.querySelectorAll("item").forEach(item => {
            let href = item.getAttribute("href");
            let id = item.getAttribute("id");
            if (href) manifestByHref.set(href, item);
            if (id) usedIds.add(id);
        });

        let idCounter = 1;
        function nextId(relPath) {
            let base = relPath.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").slice(-48) || "item";
            let candidate = base;
            while (usedIds.has(candidate)) candidate = `${base}_${idCounter++}`;
            usedIds.add(candidate);
            return candidate;
        }

        Array.from(fileMap.keys()).sort(compareDocumentPaths).forEach(relPath => {
            if (manifestByHref.has(relPath)) return;
            let item = opfDoc.createElementNS(OPF_NS, "item");
            item.setAttribute("id", nextId(relPath));
            item.setAttribute("href", relPath);
            item.setAttribute("media-type", getMediaType(relPath));
            if (bookProfile.navPath && relPath === bookProfile.navPath) item.setAttribute("properties", "nav");
            manifestEl.appendChild(item);
            manifestByHref.set(relPath, item);
        });

        let officialSpineByHref = new Map();
        officialSpineEntries.forEach(entry => {
            let href = officialIdToHref.get(entry.idref);
            if (href) officialSpineByHref.set(href, entry.attrs);
        });

        while (spineEl.firstChild) spineEl.removeChild(spineEl.firstChild);
        orderedTextPaths.forEach(relPath => {
            let item = manifestByHref.get(relPath);
            if (!item) return;
            let itemref = opfDoc.createElementNS(OPF_NS, "itemref");
            let attrs = officialSpineByHref.get(relPath);
            if (attrs) {
                Object.entries(attrs).forEach(([name, value]) => itemref.setAttribute(name, value));
            } else {
                itemref.setAttribute("idref", item.getAttribute("id"));
            }
            spineEl.appendChild(itemref);
        });

        applyPreferredMetadataToOpf(opfDoc);
        return new XMLSerializer().serializeToString(opfDoc);
    }
    function buildTxtContent(fileMap, orderedTextPaths) {
        let parts = [];
        orderedTextPaths.forEach(relPath => {
            let markup = fileMap.get(relPath);
            if (typeof markup !== "string") return;
            let text = extractReadableText(markup);
            if (text) parts.push(text);
        });
        return normalizeWhitespace(parts.join("\n\n"));
    }
    function triggerDownload(blob, filename) {
        let a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
    function getOpfDir() {
        return opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : "";
    }
    function resolveAssetBaseUrl(useTrial) {
        return `https://service.ebook.hyread.com.tw/ebookservice/epub/${assetId}/${useTrial ? "isTrial/" : ""}`;
    }
    function normalizeRelativePath(relPath) {
        return String(relPath || "").split("#")[0].split("?")[0].replace(/^\//, "");
    }
    function buildAssetUrl(relPath, useTrial) {
        return resolveAssetBaseUrl(useTrial) + getOpfDir() + normalizeRelativePath(relPath);
    }
    function stripAssetBase(absUrl) {
        let regularBase = resolveAssetBaseUrl(false) + getOpfDir();
        let trialBase = resolveAssetBaseUrl(true) + getOpfDir();
        if (absUrl.startsWith(trialBase)) return absUrl.slice(trialBase.length);
        if (absUrl.startsWith(regularBase)) return absUrl.slice(regularBase.length);
        return absUrl;
    }
    async function decryptMaybe(buffer) {
        if (!capturedCryptoKey || !(buffer instanceof ArrayBuffer) || buffer.byteLength <= 16) return buffer;
        try {
            let iv = buffer.slice(0, 16);
            let cipher = buffer.slice(16);
            if (cipher.byteLength === 0) return buffer;
            return await window.crypto.subtle.decrypt({ name: "AES-CBC", iv }, capturedCryptoKey, cipher);
        } catch (e) {
            return buffer;
        }
    }
    async function fetchAsset(relPath, options = {}) {
        relPath = normalizeRelativePath(relPath);
        if (!relPath) return null;

        let preferTrial = !!options.preferTrial;
        let allowTrial = options.allowTrial !== false;
        let allowRegular = options.allowRegular !== false;
        let order = [];
        if (preferTrial) {
            if (allowTrial) order.push(true);
            if (allowRegular) order.push(false);
        } else {
            if (allowRegular) order.push(false);
            if (allowTrial) order.push(true);
        }

        for (let useTrial of order) {
            let url = buildAssetUrl(relPath, useTrial);
            try {
                let res = await fetch(url);
                if (!res.ok) continue;
                let encrypted = await res.arrayBuffer();
                let buffer = await decryptMaybe(encrypted);
                return {
                    relPath,
                    url,
                    useTrial,
                    encrypted,
                    buffer,
                    blob: new Blob([buffer], { type: options.mimeType || getMediaType(relPath) })
                };
            } catch (e) {
                console.warn("资源抓取失败:", relPath, useTrial ? "trial" : "regular", e);
            }
        }
        return null;
    }
    async function assetExists(relPath, options = {}) {
        relPath = normalizeRelativePath(relPath);
        if (!relPath) return false;
        let key = JSON.stringify({
            relPath,
            preferTrial: !!options.preferTrial,
            allowTrial: options.allowTrial !== false,
            allowRegular: options.allowRegular !== false
        });
        if (assetExistenceCache.has(key)) return assetExistenceCache.get(key);
        let exists = !!(await fetchAsset(relPath, options));
        assetExistenceCache.set(key, exists);
        return exists;
    }
    function decodeTextBuffer(buffer) {
        let text = new TextDecoder().decode(buffer);
        let startIdx = text.search(/<html|<xml|<!DOCTYPE|<ncx/i);
        if (startIdx > 0) text = text.substring(startIdx);
        return text.replace(/^\uFEFF/, "");
    }
    function splitPath(path) {
        return normalizeRelativePath(path).split("/").filter(Boolean);
    }
    function dirname(path) {
        let clean = normalizeRelativePath(path);
        let idx = clean.lastIndexOf("/");
        return idx === -1 ? "" : clean.slice(0, idx + 1);
    }
    function joinPath(parts) {
        return parts.filter(Boolean).join("/");
    }
    function relativePath(fromFile, toFile) {
        let fromParts = splitPath(dirname(fromFile));
        let toParts = splitPath(toFile);
        while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
            fromParts.shift();
            toParts.shift();
        }
        return joinPath([
            ...Array(fromParts.length).fill(".."),
            ...toParts
        ]) || ".";
    }
    function getFileExtension(relPath, fallback = "bin") {
        let match = normalizeRelativePath(relPath).match(/\.([a-z0-9]+)$/i);
        return match ? match[1].toLowerCase() : fallback;
    }
    function makeSyntheticXhtmlPath(imageRelPath, usedPaths, preferredDir = "generated/") {
        let normalized = normalizeRelativePath(imageRelPath);
        let stem = normalized.split("/").pop().replace(/\.[^.]+$/, "");
        let dir = preferredDir.endsWith("/") ? preferredDir : preferredDir + "/";
        let candidate = `${dir}${stem}.xhtml`;
        let index = 1;
        while (usedPaths.has(candidate)) {
            candidate = `${dir}${stem}-${index++}.xhtml`;
        }
        usedPaths.add(candidate);
        return candidate;
    }
    function injectHeadContent(markup, addition) {
        if (/<head[^>]*>/i.test(markup)) {
            return markup.replace(/<head([^>]*)>/i, `<head$1>${addition}`);
        }
        if (/<html[^>]*>/i.test(markup)) {
            return markup.replace(/<html([^>]*)>/i, `<html$1><head>${addition}</head>`);
        }
        return `<head>${addition}</head>${markup}`;
    }
    async function readNavigationLinkedPaths() {
        let navCandidates = [bookProfile.navPath, "navigation-documents.xhtml", "nav.xhtml", "toc.xhtml"]
            .map(normalizeRelativePath)
            .filter(Boolean);
        let visited = new Set();
        let found = new Set();

        for (let navRelPath of navCandidates) {
            if (visited.has(navRelPath)) continue;
            visited.add(navRelPath);
            let navAsset = await fetchAsset(navRelPath, { allowTrial: false, allowRegular: true });
            if (!navAsset) continue;
            let text = decodeTextBuffer(navAsset.buffer);
            let doc = new DOMParser().parseFromString(text, "text/html");
            let currentDir = dirname(navRelPath);
            doc.querySelectorAll("a[href], content[src]").forEach(el => {
                let href = el.getAttribute("href") || el.getAttribute("src");
                if (!href || href.startsWith("http") || href.startsWith("data:") || href.startsWith("#")) return;
                let targetPath = new URL(href, "http://dummy/" + currentDir).pathname.substring(1);
                found.add(normalizeRelativePath(targetPath));
            });
        }
        return Array.from(found);
    }
    function buildInferredImagePath(textPath, imagePattern) {
        let textInfo = parseNumberedTextPath(textPath);
        if (!textInfo || !imagePattern) return "";
        return `${imagePattern.prefix}${String(textInfo.num).padStart(imagePattern.width, "0")}${imagePattern.ext}`;
    }
    function buildInferredTextPath(imagePath, textPattern) {
        let imageInfo = parseNumberedImagePath(imagePath);
        if (!imageInfo || !textPattern) return "";
        return `${textPattern.prefix}${String(imageInfo.num).padStart(textPattern.width, "0")}${textPattern.ext}`;
    }
    async function expandNonNovelNumberedTextPaths(seedPaths) {
        let groups = new Map();
        seedPaths.forEach(relPath => {
            let info = parseNumberedTextPath(relPath);
            if (!info) return;
            let group = groups.get(info.groupKey);
            if (!group) {
                group = { info, nums: new Set() };
                groups.set(info.groupKey, group);
            }
            group.nums.add(info.num);
        });

        for (let group of groups.values()) {
            let knownNums = Array.from(group.nums).sort((a, b) => a - b);
            if (!knownNums.length) continue;
            let minKnown = knownNums[0];
            let maxKnown = knownNums[knownNums.length - 1];
            let lastHit = maxKnown;
            let step = 1;
            let upperMiss = maxKnown + 1;
            let finalKnown = maxKnown;

            while (upperMiss - maxKnown <= PAGE_PROBE_LIMIT) {
                let candidate = buildNumberedPath(group.info, lastHit + step);
                if (await assetExists(candidate, { allowTrial: false, allowRegular: true })) {
                    lastHit += step;
                    step *= 2;
                } else {
                    upperMiss = lastHit + step;
                    break;
                }
            }

            if (lastHit > maxKnown) {
                let low = lastHit + 1;
                let high = Math.min(upperMiss - 1, maxKnown + PAGE_PROBE_LIMIT);
                let best = lastHit;
                let left = low;
                let right = high;
                while (left <= right) {
                    let mid = Math.floor((left + right) / 2);
                    let candidate = buildNumberedPath(group.info, mid);
                    if (await assetExists(candidate, { allowTrial: false, allowRegular: true })) {
                        best = mid;
                        left = mid + 1;
                    } else {
                        right = mid - 1;
                    }
                }
                finalKnown = best;
            }
            for (let n = minKnown; n <= finalKnown; n++) group.nums.add(n);
        }

        return Array.from(groups.values())
            .flatMap(group => Array.from(group.nums).sort((a, b) => a - b).map(num => buildNumberedPath(group.info, num)))
            .sort(compareDocumentPaths);
    }
    async function getBlobImageInfo(blob) {
        if ("createImageBitmap" in window) {
            let bitmap = await createImageBitmap(blob);
            let info = { width: bitmap.width, height: bitmap.height, blob };
            bitmap.close();
            return info;
        }
        return await new Promise((resolve, reject) => {
            let img = new Image();
            let url = URL.createObjectURL(blob);
            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve({ width: img.naturalWidth, height: img.naturalHeight, blob });
            };
            img.onerror = err => {
                URL.revokeObjectURL(url);
                reject(err);
            };
            img.src = url;
        });
    }
    async function ensureJsPdfCtor() {
        let ctor = window.jspdf?.jsPDF || window.jsPDF || (typeof window.jspdf === "function" ? window.jspdf : null);
        if (ctor) return ctor;

        await new Promise((resolve, reject) => {
            let script = document.createElement("script");
            script.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
            script.onload = resolve;
            script.onerror = () => reject(new Error("jsPDF 脚本加载失败"));
            document.head.appendChild(script);
        });

        ctor = window.jspdf?.jsPDF || window.jsPDF || (typeof window.jspdf === "function" ? window.jspdf : null);
        if (!ctor) throw new Error("jsPDF 未加载");
        return ctor;
    }
    function buildFixedLayoutNav(navRelPath, pages) {
        let items = pages.map((page, index) => `<li><a href="${escapeXml(relativePath(navRelPath, page.xhtmlPath))}">第 ${index + 1} 页</a></li>`).join("\n");
        return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-TW">
  <head>
    <meta charset="utf-8" />
    <title>${escapeXml(bookInfo.title)}</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>${escapeXml(bookInfo.title)}</h1>
      <ol>
${items}
      </ol>
    </nav>
  </body>
</html>`;
    }
    function buildFixedLayoutPageXhtml(page, index) {
        let imageRel = relativePath(page.xhtmlPath, page.imagePath);
        return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-TW">
  <head>
    <meta charset="utf-8" />
    <title>${escapeXml(bookInfo.title)} - ${index + 1}</title>
    <meta name="viewport" content="width=${page.width}, height=${page.height}" />
    <style>
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #fff; }
      body { overflow: hidden; }
      img { display: block; width: 100%; height: 100%; object-fit: contain; }
    </style>
  </head>
  <body>
    <img src="${escapeXml(imageRel)}" alt="Page ${index + 1}" />
  </body>
</html>`;
    }
    async function renderPageViaIframe(pageRelPath, pageMarkup) {
        let baseHref = resolveAssetBaseUrl(false) + getOpfDir();
        let hook = `<base href="${escapeXml(baseHref)}"><script>
window.__hyreadRender = { drawCalls: 0, lastDraw: 0, error: "" };
(() => {
  const orig = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function() {
    window.__hyreadRender.drawCalls++;
    window.__hyreadRender.lastDraw = Date.now();
    return orig.apply(this, arguments);
  };
  window.addEventListener('error', e => { window.__hyreadRender.error = String((e && (e.message || e.error)) || 'render error'); });
  window.addEventListener('unhandledrejection', e => { window.__hyreadRender.error = String((e && e.reason) || 'render rejection'); });
})();
</script>`;
        let html = injectHeadContent(pageMarkup, hook);

        return await new Promise((resolve, reject) => {
            let iframe = document.createElement("iframe");
            iframe.style.cssText = "position:fixed;left:-99999px;top:-99999px;width:10px;height:10px;opacity:0;pointer-events:none;";
            iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
            let timer = null;
            let startTime = Date.now();

            function cleanup() {
                if (timer) clearTimeout(timer);
                iframe.remove();
            }
            function fail(message) {
                cleanup();
                reject(new Error(message));
            }
            async function tryCapture() {
                try {
                    let win = iframe.contentWindow;
                    let doc = iframe.contentDocument;
                    if (!win || !doc) {
                        if (Date.now() - startTime > 12000) return fail(`页面渲染超时: ${pageRelPath}`);
                        timer = setTimeout(tryCapture, 100);
                        return;
                    }
                    let state = win.__hyreadRender || {};
                    if (state.error) return fail(`页面脚本报错: ${state.error}`);
                    let canvas = doc.querySelector("canvas");
                    if (!canvas || !canvas.width || !canvas.height) {
                        if (Date.now() - startTime > 12000) return fail(`页面未产出 canvas: ${pageRelPath}`);
                        timer = setTimeout(tryCapture, 120);
                        return;
                    }
                    let idleMs = Date.now() - (state.lastDraw || 0);
                    if ((state.drawCalls || 0) === 0 || idleMs < 250) {
                        if (Date.now() - startTime > 12000) return fail(`页面绘制超时: ${pageRelPath}`);
                        timer = setTimeout(tryCapture, 120);
                        return;
                    }
                    canvas.toBlob(async blob => {
                        if (!blob) return fail(`canvas 导出失败: ${pageRelPath}`);
                        let info = await getBlobImageInfo(blob);
                        cleanup();
                        resolve({
                            blob,
                            width: info.width,
                            height: info.height,
                            mimeType: blob.type || "image/png",
                            source: "xhtml"
                        });
                    }, "image/png");
                } catch (e) {
                    fail(`页面还原失败: ${e.message}`);
                }
            }

            document.body.appendChild(iframe);
            iframe.srcdoc = html;
            timer = setTimeout(tryCapture, 200);
        });
    }
    async function resolveFixedLayoutPageImage(pageRelPath, fallbackImageRelPath) {
        if (fallbackImageRelPath) {
            let directImageAsset = await fetchAsset(fallbackImageRelPath, { preferTrial: true, allowRegular: true });
            if (directImageAsset) {
                let info = await getBlobImageInfo(directImageAsset.blob);
                return {
                    blob: directImageAsset.blob,
                    width: info.width,
                    height: info.height,
                    mimeType: directImageAsset.blob.type || getMediaType(fallbackImageRelPath),
                    source: directImageAsset.useTrial ? "trial-image" : "direct-image",
                    imageRelPath: fallbackImageRelPath
                };
            }
        }

        if (!pageRelPath) throw new Error(`页面文件缺失，且图片直取失败: ${fallbackImageRelPath || "unknown"}`);
        let pageAsset = await fetchAsset(pageRelPath, { preferTrial: false });
        if (!pageAsset) throw new Error(`页面文件抓取失败: ${pageRelPath}`);
        let pageMarkup = decodeTextBuffer(pageAsset.buffer);
        let rendered = await renderPageViaIframe(pageRelPath, pageMarkup);
        return {
            ...rendered,
            imageRelPath: fallbackImageRelPath || pageRelPath.replace(/\.(xhtml|html|htm)$/i, ".png")
        };
    }
    async function getFixedLayoutPages() {
        let existingPages = [];
        officialSpineEntries.forEach(entry => {
            let href = officialIdToHref.get(entry.idref);
            if (!href || !isTextDocument(href) || isNavigationDocument(href)) return;
            let meta = officialManifestMeta.get(href) || {};
            let fallbackHref = meta.fallback ? (officialIdToHref.get(meta.fallback) || "") : "";
            existingPages.push({
                idref: entry.idref,
                href,
                fallbackHref,
                itemProps: meta.properties || "",
                spineProps: entry.attrs.properties || ""
            });
        });

        let usedXhtmlPaths = new Set(existingPages.map(page => page.href));
        let preferredGeneratedDir = dirname(existingPages[0]?.href || bookProfile.navPath || "generated/nav.xhtml") || "generated/";
        let numberedImageEntries = Array.from(officialManifestMeta.entries())
            .filter(([href, meta]) => /^image\//i.test(meta.mediaType || "") && parseNumberedImagePath(href))
            .map(([href, meta]) => ({ href, meta, info: parseNumberedImagePath(href) }))
            .sort((a, b) => compareImagePaths(a.href, b.href));
        let numberedTextPaths = new Set(existingPages.map(page => page.href).filter(path => parseNumberedTextPath(path)));

        Array.from(officialManifestMeta.entries())
            .filter(([href, meta]) => /application\/xhtml\+xml|text\/html/i.test(meta.mediaType || ""))
            .map(([href]) => href)
            .filter(href => !isNavigationDocument(href) && parseNumberedTextPath(href))
            .forEach(href => numberedTextPaths.add(href));

        let navLinkedPaths = await readNavigationLinkedPaths();
        navLinkedPaths.filter(path => parseNumberedTextPath(path)).forEach(path => numberedTextPaths.add(path));
        let expandedNumberedTextPaths = bookProfile.isNovel ? Array.from(numberedTextPaths) : await expandNonNovelNumberedTextPaths(Array.from(numberedTextPaths));

        let existingTextPatterns = Array.from(numberedTextPaths)
            .map(parseNumberedTextPath)
            .filter(Boolean);
        let defaultTextPattern = existingTextPatterns[0] || null;

        let pageByFallback = new Map();
        let pageByHref = new Map();
        let imagePatternByTextGroup = new Map();
        let textPatternByImageGroup = new Map();
        existingPages.forEach(page => {
            if (page.href) pageByHref.set(page.href, page);
            if (page.fallbackHref) pageByFallback.set(page.fallbackHref, page);
            let textInfo = parseNumberedTextPath(page.href || "");
            let imageInfo = parseNumberedImagePath(page.fallbackHref || "");
            if (textInfo && imageInfo && textInfo.num === imageInfo.num) {
                imagePatternByTextGroup.set(textInfo.groupKey, imageInfo);
                textPatternByImageGroup.set(imageInfo.groupKey, textInfo);
            }
        });

        let expandedNumberedPages = expandedNumberedTextPaths.map(textPath => {
            let existing = pageByHref.get(textPath);
            if (existing) return existing;
            let textInfo = parseNumberedTextPath(textPath);
            let fallbackHref = buildInferredImagePath(textPath, imagePatternByTextGroup.get(textInfo?.groupKey) || null);
            if (!fallbackHref) {
                let numberedImage = numberedImageEntries.find(entry => entry.info.num === textInfo?.num);
                fallbackHref = numberedImage?.href || "";
            }
            return {
                idref: "",
                href: textPath,
                fallbackHref,
                itemProps: "",
                spineProps: "",
                synthetic: true,
                syntheticHref: textPath
            };
        });
        let coveredFallbacks = new Set(expandedNumberedPages.map(page => page.fallbackHref).filter(Boolean));

        numberedImageEntries.forEach(({ href }) => {
            if (coveredFallbacks.has(href)) return;
            let existing = pageByFallback.get(href);
            if (existing) {
                expandedNumberedPages.push(existing);
                coveredFallbacks.add(href);
                return;
            }
            let inferredHref = buildInferredTextPath(href, textPatternByImageGroup.get(parseNumberedImagePath(href)?.groupKey) || defaultTextPattern);
            let finalHref = inferredHref || "";
            expandedNumberedPages.push({
                idref: "",
                href: finalHref,
                fallbackHref: href,
                itemProps: "",
                spineProps: "",
                synthetic: true,
                syntheticHref: finalHref || makeSyntheticXhtmlPath(href, usedXhtmlPaths, preferredGeneratedDir)
            });
            coveredFallbacks.add(href);
        });
        expandedNumberedPages.sort((a, b) => {
            let aPath = a.href || a.syntheticHref || a.fallbackHref || "";
            let bPath = b.href || b.syntheticHref || b.fallbackHref || "";
            return compareDocumentPaths(aPath, bPath);
        });

        let pages = [];
        let insertedNumberedBlock = false;
        existingPages.forEach(page => {
            if (parseNumberedImagePath(page.fallbackHref || "") || parseNumberedTextPath(page.href || "")) {
                if (!insertedNumberedBlock) {
                    pages.push(...expandedNumberedPages);
                    insertedNumberedBlock = true;
                }
            } else {
                pages.push(page);
            }
        });
        if (!insertedNumberedBlock) pages.push(...expandedNumberedPages);

        if (!pages.length && numberedImageEntries.length) {
            return expandedNumberedPages;
        }
        return pages;
    }
    async function collectFixedLayoutPages(progressLabel) {
        let cacheKey = getFixedLayoutCacheKey();
        if (fixedLayoutPagesCache.has(cacheKey)) {
            let cachedPages = fixedLayoutPagesCache.get(cacheKey);
            SakiProgress.setText(`⚡ 读取缓存页面 [${cachedPages.length}]`);
            return cloneFixedLayoutPages(cachedPages);
        }
        if (fixedLayoutPagesPromiseCache.has(cacheKey)) {
            return cloneFixedLayoutPages(await fixedLayoutPagesPromiseCache.get(cacheKey));
        }

        let pending = (async () => {
            let pages = await getFixedLayoutPages();
            if (!pages.length) throw new Error("未识别到可导出的版式页面");
            let results = [];
            for (let i = 0; i < pages.length; i++) {
                let page = pages[i];
                let resolvedXhtmlPath = page.href || page.syntheticHref || `generated/page-${String(i + 1).padStart(4, "0")}.xhtml`;
                SakiProgress.setPercent(10 + (i / Math.max(pages.length, 1)) * 75);
                SakiProgress.setText(`${progressLabel} [${i + 1}/${pages.length}]`);
                let rendered = await resolveFixedLayoutPageImage(page.href, page.fallbackHref);
                let ext = rendered.mimeType.includes("png") ? "png" : (rendered.mimeType.includes("webp") ? "webp" : "jpg");
                let baseImagePath = page.fallbackHref || page.href.replace(/\.(xhtml|html|htm)$/i, `.${ext}`);
                let imagePath = page.fallbackHref ? page.fallbackHref.replace(/\.[^.]+$/, `.${ext}`) : baseImagePath;
                if (!/\.[a-z0-9]+$/i.test(imagePath)) imagePath += `.${ext}`;
                results.push({
                    ...page,
                    blob: rendered.blob,
                    width: rendered.width,
                    height: rendered.height,
                    mimeType: rendered.mimeType,
                    imagePath,
                    xhtmlPath: resolvedXhtmlPath,
                    source: rendered.source
                });
            }
            fixedLayoutPagesCache.set(cacheKey, results);
            return results;
        })();

        fixedLayoutPagesPromiseCache.set(cacheKey, pending);
        try {
            return cloneFixedLayoutPages(await pending);
        } finally {
            fixedLayoutPagesPromiseCache.delete(cacheKey);
        }
    }
    async function exportFixedLayoutCbz(pages) {
        let zip = new JSZip();
        zip.file("ComicInfo.xml", buildComicInfoXml(pages.length));
        for (let i = 0; i < pages.length; i++) {
            let page = pages[i];
            let ext = getFileExtension(page.imagePath, page.mimeType.includes("png") ? "png" : "jpg");
            zip.file(`${String(i + 1).padStart(4, "0")}.${ext}`, page.blob);
        }
        let blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
        let safeName = bookInfo.title.replace(/[\\/:*?"<>|]/g, "_");
        triggerDownload(blob, safeName + ".cbz");
    }
    async function blobToDataUrl(blob) {
        return await new Promise((resolve, reject) => {
            let reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
    async function exportFixedLayoutPdf(pages) {
        let jsPDFCtor = await ensureJsPdfCtor();
        let pdf = null;
        for (let i = 0; i < pages.length; i++) {
            let page = pages[i];
            SakiProgress.setPercent(88 + (i / Math.max(pages.length, 1)) * 10);
            SakiProgress.setText(`📄 正在生成 PDF [${i + 1}/${pages.length}]`);
            let dataUrl = await blobToDataUrl(page.blob);
            let format = [page.width, page.height];
            let orientation = page.width >= page.height ? "landscape" : "portrait";
            if (!pdf) {
                pdf = new jsPDFCtor({ orientation, unit: "pt", format, compress: true });
            } else {
                pdf.addPage(format, orientation);
            }
            let imageType = page.mimeType.includes("png") ? "PNG" : "JPEG";
            pdf.addImage(dataUrl, imageType, 0, 0, page.width, page.height, undefined, "FAST");
        }
        applyPdfMetadata(pdf);
        let safeName = bookInfo.title.replace(/[\\/:*?"<>|]/g, "_");
        pdf.save(safeName + ".pdf");
    }
    async function exportFixedLayoutEpub(pages) {
        let zip = new JSZip();
        let navRelPath = bookProfile.navPath || "nav.xhtml";
        let pageProgressionDirection = bookProfile.pageProgressionDirection || "rtl";

        zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
        zip.file("META-INF/container.xml", officialContainer || `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${escapeXml(opfPath)}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

        let manifestLines = [
            `    <item id="nav" href="${escapeXml(navRelPath)}" media-type="application/xhtml+xml" properties="nav" />`
        ];
        let spineLines = [];

        zip.file(getOpfDir() + navRelPath, buildFixedLayoutNav(navRelPath, pages));

        pages.forEach((page, index) => {
            let pageId = `page_${index + 1}`;
            let imageId = `img_${index + 1}`;
            manifestLines.push(`    <item id="${pageId}" href="${escapeXml(page.xhtmlPath)}" media-type="application/xhtml+xml" />`);
            let imageProps = index === 0 ? ` properties="cover-image"` : "";
            manifestLines.push(`    <item id="${imageId}" href="${escapeXml(page.imagePath)}" media-type="${page.mimeType}"${imageProps} />`);
            let extraProps = page.spineProps ? ` properties="${escapeXml(page.spineProps)}"` : "";
            spineLines.push(`    <itemref idref="${pageId}"${extraProps} />`);

            zip.file(getOpfDir() + page.xhtmlPath, buildFixedLayoutPageXhtml(page, index));
            zip.file(getOpfDir() + page.imagePath, page.blob);
        });

        let finalOpfXml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${buildGeneratedMetadataXml([
            `    <meta property="rendition:layout">pre-paginated</meta>`,
            `    <meta property="rendition:spread">auto</meta>`,
            `    <meta property="rendition:orientation">auto</meta>`
        ])}
  </metadata>
  <manifest>
${manifestLines.join("\n")}
  </manifest>
  <spine page-progression-direction="${escapeXml(pageProgressionDirection)}">
${spineLines.join("\n")}
  </spine>
</package>`;

        zip.file(opfPath, finalOpfXml);
        let blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 9 } });
        let safeName = bookInfo.title.replace(/[\\/:*?"<>|]/g, "_");
        triggerDownload(blob, safeName + ".epub");
    }

    // --- 提取官方蓝图 ---
    function extractOfficialBlueprint() {
        try {
            if (window.ASSET_UUID) {
                let decodedData = JSON.parse(Base64.decode(window.ASSET_UUID));
                fixedLayoutPagesCache.clear();
                fixedLayoutPagesPromiseCache.clear();
                assetExistenceCache.clear();
                bookInfo = { title: "HyRead_Book", pubDate: "", isbn: "" };
                if (decodedData.assetUUID) assetId = decodedData.assetUUID;

                if (decodedData.BookXML) {
                    officialOPF = Base64.decode(decodedData.BookXML);
                    let opfDoc = new DOMParser().parseFromString(officialOPF, "text/xml");

                    bookInfo.isbn = extractPreferredIsbn(opfDoc);
                    bookInfo.pubDate = extractPreferredPubDate(opfDoc);

                    let titleEl = getElementsByLocalName(opfDoc, "title")[0] || opfDoc.querySelector("dc\\:title, title");
                    if (titleEl) bookInfo.title = titleEl.textContent.trim();

                    manifestItems = [];
                    officialManifestMeta = new Map();
                    officialIdToHref = new Map();
                    opfDoc.querySelectorAll("manifest > item").forEach(item => {
                        let href = item.getAttribute("href");
                        if (href && !href.startsWith("http")) {
                            manifestItems.push(href);
                            let meta = {
                                id: item.getAttribute("id") || "",
                                mediaType: item.getAttribute("media-type") || "",
                                properties: item.getAttribute("properties") || "",
                                fallback: item.getAttribute("fallback") || ""
                            };
                            officialManifestMeta.set(href, meta);
                            if (meta.id) officialIdToHref.set(meta.id, href);
                        }
                    });

                    officialSpine = [];
                    officialSpineEntries = [];
                    opfDoc.querySelectorAll("spine > itemref").forEach(ref => {
                        let attrs = {};
                        Array.from(ref.attributes).forEach(attr => attrs[attr.name] = attr.value);
                        officialSpineEntries.push({ idref: ref.getAttribute("idref") || "", attrs });
                        let id = ref.getAttribute("idref");
                        let item = opfDoc.querySelector(`manifest > item[id="${id}"]`);
                        if (item && item.getAttribute("href")) officialSpine.push(item.getAttribute("href"));
                    });
                    bookProfile = detectBookProfile(opfDoc);
                }

                if (decodedData.BookContainer) {
                    officialContainer = Base64.decode(decodedData.BookContainer);
                    let containerDoc = new DOMParser().parseFromString(officialContainer, "text/xml");
                    let rootfile = containerDoc.querySelector("rootfile");
                    if (rootfile) opfPath = rootfile.getAttribute("full-path");
                }
            }
        } catch (e) { console.error("❌ 蓝图提取失败:", e); }
        if (!assetId) assetId = new URLSearchParams(window.location.search).get('asset_id');
        if (SakiProgress.isLoaded) SakiProgress.refreshActionButtons();
    }

    function waitForData() {
        let timer = setInterval(() => {
            if (window.ASSET_UUID) {
                clearInterval(timer);
                extractOfficialBlueprint();
                SakiProgress.init();
            }
        }, 100);
    }

    // 拦截 Key
    if (window.crypto && window.crypto.subtle) {
        const originalImportKey = crypto.subtle.importKey;
        crypto.subtle.importKey = async function(format, keyData, algorithm, extractable, keyUsages) {
            if ((algorithm.name || algorithm) === "AES-CBC" && format === "raw") rawKeyBuffer = keyData.slice(0);
            let result = await Reflect.apply(originalImportKey, this, arguments);
            if (rawKeyBuffer && !capturedCryptoKey) {
                capturedCryptoKey = result;
                updateStatus();
            }
            return result;
        };
    }

    // ========== UI 模块 ==========
    const SakiProgress = {
        isLoaded: false, pgDiv: false, textSpan: false, progress: false,
        browserBtn: null, zipBtn: null, epubBtn: null, rawEpubBtn: null, txtBtn: null, cbzBtn: null, pdfBtn: null,
        init: function () {
            if (this.isLoaded || !document.body) return;
            this.isLoaded = true;
            this.pgDiv = document.createElement("div");
            this.pgDiv.id = "pgdiv";
            this.pgDiv.style = "z-index:999999;position:fixed;background:rgba(0,0,0,0.9);color:white;width:100%;height:38px;left:0;top:0;display:flex;align-items:center;box-shadow:0 2px 10px rgba(0,0,0,0.5);border-bottom: 2px solid #FF9800;";
            document.body.insertBefore(this.pgDiv, document.body.firstElementChild);

            this.progress = document.createElement("div");
            this.progress.style = "position:absolute;top:0;bottom:0;left:0;background:#FF9800;z-index:-1;width:0%;transition: width 0.3s;";
            this.pgDiv.appendChild(this.progress);

            this.textSpan = document.createElement("span");
            this.textSpan.style = "padding-left:15px;font-size:13px;font-weight:bold;flex-grow:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
            this.pgDiv.appendChild(this.textSpan);

            this.browserBtn = document.createElement("button");
            this.browserBtn.innerText = "📄 资源浏览器";
            this.browserBtn.style = "margin-right:10px;background:#607D8B;color:white;border:none;padding:4px 10px;cursor:pointer;border-radius:4px;font-weight:bold;";
            this.browserBtn.onclick = () => openResourceBrowser();
            this.pgDiv.appendChild(this.browserBtn);

            this.zipBtn = document.createElement("button");
            this.zipBtn.innerText = "📦 导出纯净ZIP";
            this.zipBtn.style = "margin-right:10px;background:#2196F3;color:white;border:none;padding:4px 12px;cursor:pointer;border-radius:4px;font-weight:bold;display:none;";
            this.zipBtn.onclick = () => launch("zip");
            this.pgDiv.appendChild(this.zipBtn);

            this.epubBtn = document.createElement("button");
            this.epubBtn.innerText = "📕 导出 EPUB";
            this.epubBtn.style = "margin-right:10px;background:#fff;color:#FF9800;border:none;padding:4px 15px;cursor:pointer;border-radius:4px;font-weight:bold;";
            this.epubBtn.onclick = () => launch("epub");
            this.pgDiv.appendChild(this.epubBtn);

            this.rawEpubBtn = document.createElement("button");
            this.rawEpubBtn.innerText = "📘 下载原始EPUB";
            this.rawEpubBtn.style = "margin-right:10px;background:#4CAF50;color:white;border:none;padding:4px 15px;cursor:pointer;border-radius:4px;font-weight:bold;display:none;";
            this.rawEpubBtn.onclick = () => launch("raw_epub");
            this.pgDiv.appendChild(this.rawEpubBtn);

            this.txtBtn = document.createElement("button");
            this.txtBtn.innerText = "📝 下载无图TXT";
            this.txtBtn.style = "margin-right:15px;background:#FFEB3B;color:#333;border:none;padding:4px 15px;cursor:pointer;border-radius:4px;font-weight:bold;display:none;";
            this.txtBtn.onclick = () => launch("txt");
            this.pgDiv.appendChild(this.txtBtn);

            this.cbzBtn = document.createElement("button");
            this.cbzBtn.innerText = "🗜️ 导出 CBZ";
            this.cbzBtn.style = "margin-right:10px;background:#8BC34A;color:#20310a;border:none;padding:4px 15px;cursor:pointer;border-radius:4px;font-weight:bold;display:none;";
            this.cbzBtn.onclick = () => launch("cbz");
            this.pgDiv.appendChild(this.cbzBtn);

            this.pdfBtn = document.createElement("button");
            this.pdfBtn.innerText = "📄 导出 PDF";
            this.pdfBtn.style = "margin-right:15px;background:#F44336;color:white;border:none;padding:4px 15px;cursor:pointer;border-radius:4px;font-weight:bold;display:none;";
            this.pdfBtn.onclick = () => launch("pdf");
            this.pgDiv.appendChild(this.pdfBtn);

            updateStatus();
            this.refreshActionButtons();

            function launch(mode) {
                if (!capturedCryptoKey) return alert("请向后翻几页书抓取 Key");
                if (isDownloading) return;
                SakiProgress.toggleUI(true);
                startSafeDownload(mode);
            }
        },
        setPercent: function (p) { if(this.progress) this.progress.style.width = p + "%"; },
        setText: function (t) { if(this.textSpan) this.textSpan.innerText = t; },
        refreshActionButtons: function() {
            if (!this.isLoaded) return;
            let show = btn => { if (btn) btn.style.display = "inline-block"; };
            let hide = btn => { if (btn) btn.style.display = "none"; };

            hide(this.zipBtn);
            hide(this.epubBtn);
            hide(this.rawEpubBtn);
            hide(this.txtBtn);
            hide(this.cbzBtn);
            hide(this.pdfBtn);

            if (this.browserBtn) this.browserBtn.style.display = "inline-block";
            if (isDownloading) return;

            if (bookProfile.isNovel) {
                show(this.rawEpubBtn);
                show(this.txtBtn);
            } else {
                show(this.epubBtn);
                show(this.cbzBtn);
                show(this.pdfBtn);
            }
        },
        toggleUI: function(isBusy) {
            isDownloading = isBusy;
            if (this.browserBtn) this.browserBtn.style.display = isBusy ? "none" : "inline-block";
            [this.zipBtn, this.epubBtn, this.rawEpubBtn, this.txtBtn, this.cbzBtn, this.pdfBtn].forEach(btn => {
                if (btn) btn.style.display = "none";
            });
            if (!isBusy) {
                this.setPercent(0);
                this.refreshActionButtons();
                updateStatus();
            }
        }
    };

    function updateStatus() {
        if (!SakiProgress.isLoaded) return;
        let kind = bookProfile.isNovel ? "小说" : "非小说";
        SakiProgress.setText(`${capturedCryptoKey ? "✅Key就绪" : "⏳翻页抓Key"} | 📖 ${bookInfo.title} | ${kind}`);
    }

    // ========== 内置：可视化资源浏览器 (极客破盾版) ==========
    function openResourceBrowser() {
        if (!capturedCryptoKey) return alert("打开浏览器前，请先在网页内翻页触发并抓取 Key！");
        if (!officialOPF) return alert("尚未解析到 BookXML！");

        let historyStack = [];
        let currentPlainText = ""; // 用于保存当前纯净源码供复制

        let fullKeyHex = buf2hex(rawKeyBuffer);
        let fullIvHex = "";

        // 创建 UI
        let overlay = document.createElement("div");
        overlay.style = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999999;display:flex;justify-content:center;align-items:center;";

        let modal = document.createElement("div");
        modal.style = "width:90%;max-width:1100px;height:85%;background:#1e1e1e;border-radius:8px;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.6);border: 1px solid #444;";

        // 【核心防御突破】阻断原网页防复制事件冒泡
        modal.addEventListener('selectstart', e => e.stopPropagation());
        modal.addEventListener('contextmenu', e => e.stopPropagation());
        modal.addEventListener('copy', e => e.stopPropagation());
        modal.addEventListener('keydown', e => e.stopPropagation());

        let header = document.createElement("div");
        header.style = "padding:10px 15px;background:#2d2d2d;color:white;display:flex;justify-content:space-between;align-items:center;border-top-left-radius:8px;border-top-right-radius:8px;border-bottom: 1px solid #444;";
        header.innerHTML = `<span style="font-weight:bold;color:#00BCD4;">🌐 极客资源浏览器 (无限制版)</span><span style="cursor:pointer;color:#ff5252;font-weight:bold;" id="rb-close">✖ 关闭</span>`;

        // 进阶工具栏：带手动输入框、一键复制KEY/IV、一键复制源码
        let toolbar = document.createElement("div");
        toolbar.style = "padding:10px 15px;background:#222;display:flex;flex-direction:column;gap:10px;font-size:13px;border-bottom: 1px solid #444;";
        toolbar.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;width:100%;">
                <button id="rb-back" style="background:#555;color:white;border:none;padding:5px 12px;cursor:pointer;border-radius:3px;flex-shrink:0;">⬅ 返回</button>
                <input type="text" id="rb-input" placeholder="输入相对路径 (例如 item/xhtml/p-001.xhtml)" style="flex-grow:1;padding:6px 10px;border-radius:4px;border:1px solid #555;background:#111;color:#00e676;outline:none;font-family:monospace;">
                <button id="rb-go" style="background:#00BCD4;color:white;border:none;padding:5px 15px;cursor:pointer;border-radius:3px;font-weight:bold;flex-shrink:0;">跳转/解析</button>
                <button id="rb-copy-source" style="background:#4CAF50;color:white;border:none;padding:5px 15px;cursor:pointer;border-radius:3px;font-weight:bold;flex-shrink:0;display:none;">📋 复制源码</button>
            </div>
            <div style="display:flex;align-items:center;gap:20px;color:#aaa;">
                <div title="点击复制完整 KEY" style="color:#ff9800;font-family:monospace;cursor:pointer;user-select:none;padding:2px 6px;border-radius:3px;background:#332200;" id="rb-key-btn">🔑 KEY: <span id="rb-key-txt">${fullKeyHex.substring(0,12)}...</span></div>
                <div title="点击复制完整 IV" style="color:#8bc34a;font-family:monospace;cursor:pointer;user-select:none;padding:2px 6px;border-radius:3px;background:#1a2e1a;" id="rb-iv-btn">🔓 IV: <span id="rb-iv-txt">--</span></div>
            </div>
        `;

        let contentArea = document.createElement("div");
        // 【核心防御突破】强制允许文本选中与复制
        contentArea.style = "flex-grow:1;padding:15px;overflow:auto;background:#1e1e1e;color:#d4d4d4;font-family:monospace;white-space:pre-wrap;word-break:break-all; user-select:text !important; -webkit-user-select:text !important;";

        modal.appendChild(header);
        modal.appendChild(toolbar);
        modal.appendChild(contentArea);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // --- 事件绑定 ---
        document.getElementById("rb-close").onclick = () => document.body.removeChild(overlay);

        document.getElementById("rb-back").onclick = () => {
            if (historyStack.length > 1) {
                historyStack.pop();
                loadFile(historyStack[historyStack.length - 1], true);
            }
        };

        let rbInput = document.getElementById("rb-input");
        let rbGo = document.getElementById("rb-go");
        let btnCopySource = document.getElementById("rb-copy-source");

        rbGo.onclick = () => {
            let p = rbInput.value.trim();
            if (p.startsWith("/")) p = p.substring(1);
            if (p) loadFile(p);
        };
        rbInput.addEventListener("keypress", (e) => { if (e.key === "Enter") rbGo.click(); });

        // 万能剪贴板复制工具
        function copyToClip(text, btnEl, originalText) {
            let ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = 'fixed'; ta.style.top = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand("copy");
                btnEl.innerText = "✔ 已复制";
                setTimeout(() => { btnEl.innerText = originalText; }, 1500);
            } catch (e) { alert("复制失败，请手动划选复制！"); }
            document.body.removeChild(ta);
        }

        document.getElementById("rb-key-btn").onclick = () => copyToClip(fullKeyHex, document.getElementById("rb-key-txt"), document.getElementById("rb-key-txt").innerText);
        document.getElementById("rb-iv-btn").onclick = () => {
            if (fullIvHex) copyToClip(fullIvHex, document.getElementById("rb-iv-txt"), document.getElementById("rb-iv-txt").innerText);
        };
        btnCopySource.onclick = () => copyToClip(currentPlainText, btnCopySource, "📋 复制源码");

        // --- 渲染与解密核心 ---
        async function loadFile(targetRelPath, isBack = false) {
            rbInput.value = targetRelPath;
            contentArea.innerHTML = "<span style='color:#00BCD4;'>正在向服务器请求并动态解密...</span>";
            btnCopySource.style.display = "none";
            currentPlainText = "";

            if (!isBack && historyStack[historyStack.length - 1] !== targetRelPath) {
                historyStack.push(targetRelPath);
            }

            if (targetRelPath === opfPath) {
                fullIvHex = "";
                document.getElementById("rb-iv-txt").innerText = "无需解密 (OPF明文)";
                currentPlainText = officialOPF;
                btnCopySource.style.display = "inline-block";
                renderTextWithLinks(officialOPF, targetRelPath);
                return;
            }

            try {
                let asset = await fetchAsset(targetRelPath, {
                    preferTrial: /\.(jpe?g|png|gif|svg|webp)$/i.test(targetRelPath),
                    allowTrial: true,
                    allowRegular: true
                });
                if (!asset) {
                    contentArea.innerHTML = `<span style="color:#ff5252;">加载失败：资源不存在或无法解密\n路径: ${targetRelPath}</span>`;
                    return;
                }

                let buffer = asset.encrypted;
                let iv = buffer.slice(0, 16);

                fullIvHex = buf2hex(iv);
                document.getElementById("rb-iv-txt").innerText = fullIvHex.substring(0,12) + "...";

                let decrypted = asset.buffer;

                if (/\.(xhtml|html|htm|css|ncx|xml|opf)$/i.test(targetRelPath)) {
                    let text = new TextDecoder().decode(decrypted);
                    let startIdx = text.search(/<html|<xml|<!DOCTYPE|<ncx/i);
                    if (startIdx > 0) text = text.substring(startIdx);

                    currentPlainText = text; // 保存纯文本供按钮复制
                    btnCopySource.style.display = "inline-block";

                    renderTextWithLinks(text, targetRelPath);
                } else if (/\.(jpe?g|png|gif|svg)$/i.test(targetRelPath)) {
                    let blob = new Blob([decrypted]);
                    let url = URL.createObjectURL(blob);
                    contentArea.innerHTML = `<img src="${url}" style="max-width:100%; object-fit:contain; background:#fff; box-shadow: 0 0 10px rgba(0,0,0,0.5);">`;
                } else {
                    contentArea.innerHTML = `<span style="color:#aaa;">这是一个纯二进制文件，无法转为文本预览。<br>文件大小: ${decrypted.byteLength} Bytes</span>`;
                }
            } catch (err) {
                contentArea.innerHTML = `<span style="color:#ff5252;">发生异常: ${err.message}</span>`;
            }
        }

        // 超链接转化器
        function renderTextWithLinks(text, currentPath) {
            let currentDir = currentPath.includes("/") ? currentPath.substring(0, currentPath.lastIndexOf("/") + 1) : "";
            let safeText = escapeXml(text);

            let linkified = safeText.replace(/(href|src)=&quot;([^&]+)&quot;/g, (match, attr, link) => {
                if (link.startsWith("http") || link.startsWith("data:") || link.startsWith("#")) return match;
                let targetPath = new URL(link, "http://dummy/" + currentDir).pathname.substring(1);
                return `${attr}=&quot;<span class="rb-link" data-target="${targetPath}" style="color:#00e676;cursor:pointer;text-decoration:underline;" title="点击立刻跳转解析该文件">${link}</span>&quot;`;
            });

            contentArea.innerHTML = linkified;
            contentArea.querySelectorAll(".rb-link").forEach(el => {
                el.onclick = (e) => loadFile(e.target.getAttribute("data-target"));
            });
        }

        // 启动加载第一页
        loadFile(opfPath);
    }

    // ========== 核心：安全打包引擎 ==========
    async function startSafeDownload(mode) {
        SakiProgress.setPercent(5);

        let isTxtMode = mode === "txt";
        let isZipMode = mode === "zip";
        let isNovelRawEpub = mode === "raw_epub";
        let isPdfMode = mode === "pdf";
        let isCbzMode = mode === "cbz";
        let opfDir = getOpfDir();

        console.log(`📂 下载基址: ${resolveAssetBaseUrl(false)}`);

        if (!bookProfile.isNovel && (mode === "epub" || isPdfMode || isCbzMode)) {
            try {
                let label = isCbzMode ? "CBZ 页面还原中" : (isPdfMode ? "PDF 页面还原中" : "EPUB 页面还原中");
                let pages = await collectFixedLayoutPages(label);
                SakiProgress.setPercent(92);
                if (isCbzMode) {
                    SakiProgress.setText("🗜️ 正在生成 CBZ...");
                    await exportFixedLayoutCbz(pages);
                } else if (isPdfMode) {
                    SakiProgress.setText("📄 正在生成 PDF...");
                    await exportFixedLayoutPdf(pages);
                } else {
                    SakiProgress.setText("📕 正在生成 fixed-layout EPUB...");
                    await exportFixedLayoutEpub(pages);
                }
                SakiProgress.setPercent(100);
                SakiProgress.setText(`🎉 ${isCbzMode ? "CBZ" : (isPdfMode ? "PDF" : "EPUB")} 导出完成！(3秒后重置)`);
            } catch (e) {
                SakiProgress.setText("❌ 导出失败: " + e.message);
            }
            setTimeout(() => SakiProgress.toggleUI(false), 3000);
            return;
        }

        let zip = new JSZip();
        let fileMap = new Map();
        let numberedGroups = new Map();
        let initialTasks = isTxtMode ? manifestItems.filter(isTextResource) : [...manifestItems];
        let taskQueue = [...initialTasks];
        let enqueuedSet = new Set(initialTasks);
        let dynamicSpine = [...officialSpine];
        let doneCount = 0;

        ['navigation-documents.xhtml', 'nav.xhtml', 'toc.xhtml', bookProfile.navPath].forEach(f => {
            if (f && !enqueuedSet.has(f)) { taskQueue.push(f); enqueuedSet.add(f); }
        });

        function registerNumberedSeed(relPath) {
            if (!bookProfile.isNovel) return;
            let info = parseNumberedTextPath(relPath);
            if (!info) return;

            let group = numberedGroups.get(info.groupKey);
            if (!group) {
                group = {
                    prefix: info.prefix,
                    width: info.width,
                    ext: info.ext,
                    seen: new Set()
                };
                numberedGroups.set(info.groupKey, group);
            }
            if (group.seen.has(info.num)) return;

            let existing = Array.from(group.seen);
            group.seen.add(info.num);
            existing.forEach(otherNum => {
                let gap = Math.abs(otherNum - info.num) - 1;
                if (gap <= 0 || gap > GAP_PROBE_LIMIT) return;
                let start = Math.min(otherNum, info.num) + 1;
                let end = Math.max(otherNum, info.num) - 1;
                for (let n = start; n <= end; n++) {
                    let candidate = `${group.prefix}${String(n).padStart(group.width, "0")}${group.ext}`;
                    enqueue(candidate, true);
                }
            });
        }
        function enqueue(relPath, speculative = false) {
            if (!relPath) return;
            relPath = relPath.split("#")[0].replace(/^\//, "");
            if (!relPath || relPath.startsWith("http") || relPath.startsWith("data:")) return;
            if (isTxtMode && !isTextResource(relPath)) return;
            if (!enqueuedSet.has(relPath)) {
                taskQueue.push(relPath);
                enqueuedSet.add(relPath);
            }
            if (!speculative) registerNumberedSeed(relPath);
        }

        initialTasks.forEach(path => registerNumberedSeed(path));

        async function worker() {
            while (taskQueue.length > 0) {
                let relPath = taskQueue.shift();
                let fileUrl = resolveAssetBaseUrl(false) + opfDir + relPath;

                try {
                    let isImageAsset = /\.(jpe?g|png|gif|svg|webp)$/i.test(relPath);
                    let asset = await fetchAsset(relPath, {
                        preferTrial: isImageAsset,
                        allowTrial: true,
                        allowRegular: true
                    });
                    if (!asset) continue;
                    let decrypted = asset.buffer;
                    fileUrl = asset.url;

                    registerNumberedSeed(relPath);

                    if (/\.(xhtml|html|htm|ncx|xml|css)$/i.test(relPath)) {
                        let text = new TextDecoder().decode(decrypted);
                        let startIdx = text.search(/<html|<xml|<!DOCTYPE|<ncx/i);
                        if (startIdx > 0) text = text.substring(startIdx);
                        text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");

                        if (!/\.css$/i.test(relPath) || !isTxtMode) fileMap.set(relPath, text);

                        if (/\.(xhtml|html|htm|svg)$/i.test(relPath)) {
                            let doc = new DOMParser().parseFromString(text, "text/html");

                            if (/nav|toc|navigation/i.test(relPath)) {
                                doc.querySelectorAll('a[href], content[src]').forEach(el => {
                                    let href = el.getAttribute('href') || el.getAttribute('src');
                                    if (href && !href.startsWith('http') && !href.startsWith('#')) {
                                        let absUrl = new URL(href, fileUrl).href.split('#')[0];
                                        let newRelPath = stripAssetBase(absUrl);
                                        enqueue(newRelPath);
                                        if (el.tagName.toLowerCase() === 'a' && !dynamicSpine.includes(newRelPath)) {
                                            dynamicSpine.push(newRelPath);
                                        }
                                    }
                                });
                            } else {
                                doc.querySelectorAll('a[href]').forEach(el => {
                                    let href = el.getAttribute('href');
                                    if (href && !href.startsWith('http') && !href.startsWith('#')) {
                                        let absUrl = new URL(href, fileUrl).href.split('#')[0];
                                        enqueue(stripAssetBase(absUrl));
                                    }
                                });
                            }

                            if (!isTxtMode) {
                                doc.querySelectorAll('link, img, image, use').forEach(el => {
                                    let href = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('xlink:href');
                                    if (href && !href.startsWith('http') && !href.startsWith('data:') && !href.startsWith('#')) {
                                        let absUrl = new URL(href, fileUrl).href.split('#')[0];
                                        enqueue(stripAssetBase(absUrl));
                                    }
                                });
                            }
                        } else if (/\.css$/i.test(relPath) && !isTxtMode) {
                            let match, urlRegex = /url\(['"]?([^'"()]+)['"]?\)/g;
                            while ((match = urlRegex.exec(text)) !== null) {
                                if (match[1] && !match[1].startsWith('http') && !match[1].startsWith('data:')) {
                                    let absUrl = new URL(match[1], fileUrl).href.split('#')[0];
                                    enqueue(stripAssetBase(absUrl));
                                }
                            }
                        }
                    } else if (!isTxtMode) {
                        fileMap.set(relPath, decrypted);
                    }

                    doneCount++;
                    SakiProgress.setPercent(10 + (doneCount / enqueuedSet.size * 80));
                    if (doneCount % 5 === 0) SakiProgress.setText(`📥 下载中 [${doneCount}/${enqueuedSet.size}]`);
                } catch (e) { console.error(`💥 异常: ${relPath}`, e); }
            }
        }

        await new Promise(resolve => {
            let active = 0;
            function pump() {
                if (taskQueue.length === 0 && active === 0) { resolve(); return; }
                while (taskQueue.length > 0 && active < MAX_CONCURRENT) {
                    active++;
                    worker().finally(() => { active--; pump(); });
                }
            }
            pump();
        });

        // ================= 安全打包阶段 =================
        SakiProgress.setPercent(90);
        let orderedTextPaths = buildOrderedTextPaths(fileMap, dynamicSpine);
        let safeName = bookInfo.title.replace(/[\\/:*?"<>|]/g, "_");
        let targetLabel = isTxtMode ? "无图 TXT" : (isZipMode ? "纯净 ZIP" : "EPUB");
        SakiProgress.setText(`📦 正在生成 ${targetLabel}...`);

        try {
            if (isTxtMode) {
                let txt = buildTxtContent(fileMap, orderedTextPaths);
                if (!txt) throw new Error("未提取到可用正文");
                triggerDownload(new Blob([txt], { type: "text/plain;charset=utf-8" }), safeName + ".txt");
            } else {
                if (isZipMode) {
                    for (let [path, data] of fileMap.entries()) zip.file(path, data);
                } else {
                    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
                    zip.file("META-INF/container.xml", officialContainer);

                    let finalOpfXml = "";
                    if (isNovelRawEpub) {
                        finalOpfXml = buildNovelPatchedOpf(fileMap, orderedTextPaths);
                    } else {
                        let manifestStr = "";
                        let spineStr = "";
                        let idCounter = 1;
                        let pathToId = {};

                        for (let relPath of fileMap.keys()) {
                            let id = "idx_" + idCounter++;
                            pathToId[relPath] = id;
                            let props = (/nav\.xhtml|navigation/i.test(relPath)) ? ' properties="nav"' : '';
                            manifestStr += `    <item id="${id}" href="${escapeXml(relPath)}" media-type="${getMediaType(relPath)}"${props}/>\n`;
                        }

                        let addedToSpine = new Set();
                        function addSpineRef(relPath) {
                            let id = pathToId[relPath];
                            if (id && !addedToSpine.has(id) && /\.(xhtml|html|htm)$/i.test(relPath)) {
                                spineStr += `    <itemref idref="${id}"/>\n`;
                                addedToSpine.add(id);
                            }
                        }

                        for (let p of fileMap.keys()) if (/cover\./i.test(p)) addSpineRef(p);
                        dynamicSpine.forEach(p => addSpineRef(p));
                        for (let p of fileMap.keys()) addSpineRef(p);

                        finalOpfXml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${buildGeneratedMetadataXml([
                            `    <meta property="rendition:layout">reflowable</meta>`
                        ])}
  </metadata>
  <manifest>\n${manifestStr}  </manifest>
  <spine page-progression-direction="rtl">\n${spineStr}  </spine>
</package>`;
                    }

                    zip.file(opfPath, finalOpfXml);
                    for (let [relPath, data] of fileMap.entries()) {
                        zip.file(opfDir + relPath, data);
                    }
                }

                let blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 9 } });
                triggerDownload(blob, safeName + (isZipMode ? ".zip" : ".epub"));
            }

            SakiProgress.setPercent(100);
            SakiProgress.setText(`🎉 ${targetLabel} 导出完成！(3秒后重置)`);
        } catch (e) {
            SakiProgress.setText("❌ 打包失败: " + e.message);
        }

        setTimeout(() => SakiProgress.toggleUI(false), 3000);
    }

    waitForData();

})();
