// ==UserScript==
// @name         HyRead窃书贼
// @namespace    https://qinlili.bid
// @version      0.21.0
// @description  针对HyRead平台epub电子书的导出！
// @author       NBXX
// @match        https://service.ebook.hyread.com.tw/ebookservice/epubreader/hyread/v3/openbook2.jsp?*
// @icon         https://webcdn2.ebook.hyread.com.tw/Template/store/favicon/favicon.ico
// @grant        none
// @run-at       document-start
// @require      https://lib.baomitu.com/jquery/3.6.0/jquery.min.js#sha512-894YE6QWD5I59HgZOGReFYm4dnWc1Qt5NtvYSaNcOP+u1T9qYdvdihz0PPSiiqn/+/3e7Jo4EaG7TubfWGUrMQ==
// @require      https://lib.baomitu.com/jszip/3.10.1/jszip.min.js#sha512-XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg==
// @require      https://cdn.jsdelivr.net/npm/js-base64@3.7.2/base64.min.js
// @license      MPL2.0
// ==/UserScript==

(function () {
    'use strict';

    const MAX_CONCURRENT = 8; // 并发线程数

    let capturedCryptoKey = null;
    let assetId = null;
    let isDownloading = false;

    // 元数据与官方 OPF 提取缓存
    let bookInfo = { title: "HyRead_Book", author: "Unknown", publisher: "Unknown", pubyear: "" };
    let officialManifest = []; // 官方 OPF 中的文件列表 (相对 OPF)
    let officialSpine = [];    // 官方 OPF 中的阅读顺序 (相对 OPF)

    // --- 提取官方元数据与 OPF 蓝图 ---
    function extractOfficialData() {
        try {
            if (window.ASSET_UUID) {
                let decodedData = JSON.parse(Base64.decode(window.ASSET_UUID));
                console.log("💎 [HyRead] 成功解析底层数据:", decodedData);

                if (decodedData.assetUUID) assetId = decodedData.assetUUID;
                if (decodedData.metadata) {
                    bookInfo.title = (decodedData.metadata.title || bookInfo.title).trim();
                    bookInfo.author = (decodedData.metadata.author || "Unknown").trim();
                    bookInfo.publisher = (decodedData.metadata.publisher || "Unknown").trim();
                    if (decodedData.metadata.pubyear) {
                        let yearMatch = decodedData.metadata.pubyear.match(/\d{4}/);
                        bookInfo.pubyear = yearMatch ? yearMatch[0] : "";
                    }
                }

                // 提取官方残缺 OPF (如果有)
                if (decodedData.BookXML) {
                    let opfDoc = new DOMParser().parseFromString(Base64.decode(decodedData.BookXML), "text/xml");

                    opfDoc.querySelectorAll("manifest > item").forEach(item => {
                        let href = item.getAttribute("href");
                        if (href && !href.startsWith("http")) officialManifest.push(href);
                    });

                    opfDoc.querySelectorAll("spine > itemref").forEach(ref => {
                        let id = ref.getAttribute("idref");
                        let item = opfDoc.querySelector(`manifest > item[id="${id}"]`);
                        if (item && item.getAttribute("href")) officialSpine.push(item.getAttribute("href"));
                    });

                    console.log(`🗺️ [HyRead] 提取官方图纸：发现 ${officialManifest.length} 个文件，骨架 ${officialSpine.length} 章。`);
                }
            }
        } catch (e) {
            console.error("❌ 底层数据解析失败:", e);
        }
        if (!assetId) assetId = new URLSearchParams(window.location.search).get('asset_id');
    }

    // --- 拦截解密 Key ---
    if (window.crypto && window.crypto.subtle) {
        const originalImportKey = crypto.subtle.importKey;
        crypto.subtle.importKey = async function(format, keyData, algorithm, extractable, keyUsages) {
            let result = await Reflect.apply(originalImportKey, this, arguments);
            try {
                if ((algorithm.name || algorithm) === "AES-CBC" && format === "raw") {
                    if (!capturedCryptoKey) {
                        capturedCryptoKey = result;
                        updateStatus();
                    }
                }
            } catch (e) {}
            return result;
        };
    }

    // ========== UI 模块 ==========
    const SakiProgress = {
        isLoaded: false, pgDiv: false, textSpan: false, progress: false,
        init: function () {
            if (this.isLoaded || !document.body) return;
            this.isLoaded = true;
            this.pgDiv = document.createElement("div");
            this.pgDiv.style = "z-index:999999;position:fixed;background:rgba(0,0,0,0.9);color:white;width:100%;height:38px;left:0;top:0;display:flex;align-items:center;box-shadow:0 2px 10px rgba(0,0,0,0.5);border-bottom: 2px solid #00BCD4;";
            document.body.insertBefore(this.pgDiv, document.body.firstElementChild);

            this.progress = document.createElement("div");
            this.progress.style = "position:absolute;top:0;bottom:0;left:0;background:#00BCD4;z-index:-1;width:0%;transition:width 0.1s linear;";
            this.pgDiv.appendChild(this.progress);

            this.textSpan = document.createElement("span");
            this.textSpan.style = "padding-left:15px;font-size:13px;font-weight:bold;flex-grow:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family: sans-serif;";
            this.pgDiv.appendChild(this.textSpan);

            let mangaLabel = document.createElement("label");
            mangaLabel.style = "margin-right:15px;font-size:12px;cursor:pointer;display:flex;align-items:center;color:#ccc;user-select:none;";
            mangaLabel.innerHTML = `<input type="checkbox" id="mangaMode" style="margin-right:4px;">漫画免打乱`;
            this.pgDiv.appendChild(mangaLabel);

            let dlBtn = document.createElement("button");
            dlBtn.innerText = "下载词书";
            dlBtn.style = "margin-right:15px;background:#fff;color:#00BCD4;border:none;padding:4px 15px;cursor:pointer;border-radius:4px;font-weight:bold;transition:all 0.2s;";
            dlBtn.onclick = () => {
                if (!assetId || !capturedCryptoKey) return alert("等待 Key 拦截中...\n请在网页点击 [下一页] 触发一次解密。");
                if (isDownloading) return;

                isDownloading = true;
                dlBtn.style.display = mangaLabel.style.display = "none";
                startFusionDownload(document.getElementById("mangaMode").checked);
            };
            this.pgDiv.appendChild(dlBtn);
            updateStatus();
        },
        setPercent: function (p) { if(this.progress) this.progress.style.width = p + "%"; },
        setText: function (t) { if(this.textSpan) this.textSpan.innerText = t; }
    };

    function updateStatus() {
        if (!SakiProgress.isLoaded) return;
        let keyStatus = capturedCryptoKey ? "✅Key就绪" : "⏳请翻页抓Key";
        let opfStatus = officialManifest.length > 0 ? `[📑底图:${officialManifest.length}项]` : "[📑无底图]";
        SakiProgress.setText(`[${keyStatus}] ${opfStatus} 📖 ${bookInfo.title}`);
    }

    // ========== 并发融合引擎主轴 ==========
    async function startFusionDownload(useMangaMode) {
        SakiProgress.setPercent(5);
        SakiProgress.setText("📡 正在锁定真实资源根目录...");

        const host = `https://service.ebook.hyread.com.tw/ebookservice/epub/${assetId}/`;
        const pathsToTry = useMangaMode ? [`${host}isTrial/`] : [host, `${host}isTrial/`];
        const subDirs = ["OEBPS/", "item/", ""];
        const probeFiles = ['nav.xhtml', 'toc.xhtml', 'toc.ncx', 'navigation-documents.xhtml'];

        let validBaseUrl = null;
        let startNavRelPath = null; // 相对于 BaseURL 的目录文件路径
        let contentDir = ""; // 例如 "OEBPS/" 或 "item/"

        // 寻找导航目录
        search: for (let base of pathsToTry) {
            for (let sub of subDirs) {
                for (let file of probeFiles) {
                    try {
                        let url = base + sub + file;
                        let res = await fetch(url);
                        if (res.ok) {
                            validBaseUrl = base;
                            startNavRelPath = sub + file;
                            contentDir = sub;
                            console.log(`抓取: ${startNavRelPath} (根目录: ${validBaseUrl})`);
                            break search;
                        }
                    } catch(e){}
                }
            }
        }

        if (!validBaseUrl) {
            isDownloading = false;
            return alert("探测失败：找不到任何书籍目录文件。");
        }

        // ================= 并发动态任务池初始化 =================
        let pendingQueue = [];
        let processedSet = new Set();
        let fileMap = new Map();

        let navSpine = []; // 爬虫发现的章节顺序
        let navMapNcxList = []; // 生成的目录节点

        // 智能去重推入队列
        function enqueue(relPath) {
            if (!processedSet.has(relPath) && !pendingQueue.includes(relPath)) {
                pendingQueue.push(relPath);
            }
        }

        // 1. 将导航文件推入队列
        enqueue(startNavRelPath);

        // 2. 将官方 OPF 图纸里的文件，转为完整相对路径后推入队列
        officialManifest.forEach(p => enqueue(contentDir + p));

        console.log(`初始加载任务池: ${pendingQueue.length} 个文件`);

        // ================= 并发工作线程 =================
        let activeWorkers = 0;
        let downloadedCount = 0;

        async function processFile(relPath) {
            try {
                let targetUrl = validBaseUrl + relPath;
                let res = await fetch(targetUrl);

                // 试读降级容错
                if (!res.ok && !validBaseUrl.includes("isTrial")) {
                    res = await fetch(validBaseUrl + "isTrial/" + relPath);
                }
                if (!res.ok) return;

                let buffer = await res.arrayBuffer();
                let decrypted;
                try {
                    decrypted = await window.crypto.subtle.decrypt({ name: "AES-CBC", iv: buffer.slice(0, 16) }, capturedCryptoKey, buffer.slice(16));
                } catch (e) { decrypted = buffer; } // 没加密的就直接存

                let isText = /\.(xhtml|html|htm|css|ncx|xml|opf)$/i.test(relPath);
                if (isText) {
                    let text = new TextDecoder().decode(decrypted);
                    let startIndex = Math.max(0, text.search(/<html|<xml|<!DOCTYPE|<ncx/i));
                    if (startIndex > 0) text = text.substring(startIndex);
                    text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
                    fileMap.set(relPath, text);

                    // ================= 爬虫：资源与目录双向发现 =================
                    if (/\.(xhtml|html|htm|ncx|svg)$/i.test(relPath)) {
                        let doc = new DOMParser().parseFromString(text, "text/html");

                        // 导航解析 (提取 Spine 和 新文件)
                        if (relPath === startNavRelPath) {
                            let playOrder = 1;
                            // 模式A: HTML <a>
                            doc.querySelectorAll('a[href]').forEach(a => {
                                let href = a.getAttribute('href');
                                if (href && !href.startsWith('http') && !href.startsWith('#')) {
                                    let abs = new URL(href, targetUrl).href.split('#')[0];
                                    let newRelPath = abs.replace(validBaseUrl, "");
                                    enqueue(newRelPath); // 新发现！加入爬虫队列
                                    if(!navSpine.includes(newRelPath)) {
                                        navSpine.push(newRelPath);
                                        let label = a.textContent.trim() || `Chapter ${playOrder}`;
                                        navMapNcxList.push(`<navPoint id="navPoint-${playOrder}" playOrder="${playOrder}"><navLabel><text>${label}</text></navLabel><content src="${newRelPath.replace(contentDir, '')}"/></navPoint>`);
                                        playOrder++;
                                    }
                                }
                            });
                            // 模式B: NCX <content>
                            doc.querySelectorAll('content[src]').forEach(c => {
                                let href = c.getAttribute('src');
                                if (href && !href.startsWith('http') && !href.startsWith('#')) {
                                    let abs = new URL(href, targetUrl).href.split('#')[0];
                                    let newRelPath = abs.replace(validBaseUrl, "");
                                    enqueue(newRelPath); // 新发现！
                                    if(!navSpine.includes(newRelPath)) {
                                        navSpine.push(newRelPath);
                                        let label = `Chapter ${playOrder}`;
                                        let parentPoint = c.closest('navPoint, navpoint');
                                        if(parentPoint) {
                                            let textEl = parentPoint.querySelector('navLabel text, navlabel text');
                                            if(textEl) label = textEl.textContent.trim();
                                        }
                                        navMapNcxList.push(`<navPoint id="navPoint-${playOrder}" playOrder="${playOrder}"><navLabel><text>${label}</text></navLabel><content src="${newRelPath.replace(contentDir, '')}"/></navPoint>`);
                                        playOrder++;
                                    }
                                }
                            });
                        }

                        // 图片、CSS等资源发现
                        doc.querySelectorAll('link, img, image, use').forEach(el => {
                            let href = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('xlink:href');
                            if (href && !href.startsWith('http') && !href.startsWith('data:') && !href.startsWith('#')) {
                                let abs = new URL(href, targetUrl).href.split('#')[0];
                                enqueue(abs.replace(validBaseUrl, "")); // 发现新资源！加入队列
                            }
                        });
                    }
                    else if (/\.css$/i.test(relPath)) {
                        let match, urlRegex = /url\(['"]?([^'"()]+)['"]?\)/g;
                        while ((match = urlRegex.exec(text)) !== null) {
                            if (match[1] && !match[1].startsWith('http') && !match[1].startsWith('data:')) {
                                let abs = new URL(match[1], targetUrl).href.split('#')[0];
                                enqueue(abs.replace(validBaseUrl, "")); // 发现背景图/字体！加入队列
                            }
                        }
                    }
                } else {
                    fileMap.set(relPath, decrypted); // 纯二进制
                }

                downloadedCount++;
                let totalKnown = processedSet.size + pendingQueue.length;
                let ratio = downloadedCount / totalKnown;
                SakiProgress.setPercent(10 + (ratio * 75));

                if (downloadedCount % 5 === 0 || downloadedCount === totalKnown) {
                    SakiProgress.setText(` [并发:${MAX_CONCURRENT}] 动态爬取中... [${downloadedCount}/${totalKnown}]`);
                }

            } catch (err) {
                console.error(`❌ 处理文件出错: ${relPath}`, err);
            }
        }

        // ================= 启动动态并发池 =================
        await new Promise(resolve => {
            function pump() {
                if (pendingQueue.length === 0 && activeWorkers === 0) {
                    resolve();
                    return;
                }
                while (pendingQueue.length > 0 && activeWorkers < MAX_CONCURRENT) {
                    let nextItem = pendingQueue.shift();
                    if (processedSet.has(nextItem)) continue; // 跳过已处理
                    processedSet.add(nextItem);

                    activeWorkers++;
                    processFile(nextItem).finally(() => {
                        activeWorkers--;
                        pump(); // 递归抽取任务，直到全部穷尽
                    });
                }
            }
            pump();
        });

        // ================= 终极重组与打包阶段 =================
        SakiProgress.setPercent(85);
        SakiProgress.setText("🛠️ 正在进行 OPF 与 爬虫目录 的终极合并...");

        let opfName = contentDir + "content.opf";
        let ncxName = contentDir + "toc.ncx";

        let tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${assetId}"/></head>
  <docTitle><text>${bookInfo.title}</text></docTitle>
  <navMap>\n    ${navMapNcxList.join('\n    ')}\n  </navMap>
</ncx>`;
        fileMap.set(ncxName, tocNcx);

        let manifestItems = "", idCounter = 1, pathToId = {};

        function getMediaType(fname) {
            if (/\.xhtml$/i.test(fname)) return "application/xhtml+xml";
            if (/\.html$/i.test(fname)) return "text/html";
            if (/\.css$/i.test(fname)) return "text/css";
            if (/\.ncx$/i.test(fname)) return "application/x-dtbncx+xml";
            if (/\.jpg|\.jpeg$/i.test(fname)) return "image/jpeg";
            if (/\.png$/i.test(fname)) return "image/png";
            if (/\.gif$/i.test(fname)) return "image/gif";
            if (/\.svg$/i.test(fname)) return "image/svg+xml";
            return "application/octet-stream";
        }

        // 1. 构建 Manifest (合并全部下载文件)
        for (let [relPath, content] of fileMap.entries()) {
            let id = "idx_" + idCounter++;
            pathToId[relPath] = id;
            let props = (relPath.includes("nav.xhtml") || relPath.includes("toc.xhtml") || relPath.includes("navigation-documents.xhtml")) ? ' properties="nav"' : '';
            let cleanHref = relPath.startsWith(contentDir) ? relPath.substring(contentDir.length) : "../" + relPath;
            manifestItems += `    <item id="${id}" href="${cleanHref}" media-type="${getMediaType(relPath)}"${props}/>\n`;
        }

        // 2. 混合拼接 Spine (骨架顺序)
        let combinedSpine = [];
        let seenInSpine = new Set();

        function addSpine(relPath) {
            if (!seenInSpine.has(relPath) && fileMap.has(relPath)) {
                combinedSpine.push(relPath);
                seenInSpine.add(relPath);
            }
        }

        // 优先将包含 cover 的前置
        for (let relPath of fileMap.keys()) {
            if (/cover\.(xhtml|html)$|p-cover/i.test(relPath)) {
                addSpine(relPath);
            }
        }

        // A: 先塞入官方 OPF 给出的顺序 (前半段绝对精准)
        officialSpine.forEach(p => addSpine(contentDir + p));

        // B: 紧接着塞入爬虫在 nav 里找到的新章节 (补全后半段)
        navSpine.forEach(p => addSpine(p));

        // C: 兜底，如果有不在目录也不在官方清单里的散装孤儿页面，全塞最后
        for (let relPath of fileMap.keys()) {
            if (/\.(xhtml|html|htm)$/i.test(relPath)) {
                addSpine(relPath);
            }
        }

        let spineItems = combinedSpine.map(relPath => `    <itemref idref="${pathToId[relPath]}"/>\n`).join("");

        // 3. 生成最终极的 OPF
        let opfXml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${bookInfo.title}</dc:title>
    <dc:creator>${bookInfo.author}</dc:creator>
    <dc:publisher>${bookInfo.publisher}</dc:publisher>
    <dc:date>${bookInfo.pubyear}</dc:date>
    <dc:identifier id="uid">${assetId}</dc:identifier>
    <dc:language>zh-TW</dc:language>
  </metadata>
  <manifest>\n${manifestItems}  </manifest>
  <spine toc="${pathToId[ncxName]}">\n${spineItems}  </spine>
</package>`;

        SakiProgress.setPercent(95);
        SakiProgress.setText("正在进行EPUB压制...");

        let zip = new JSZip();
        zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
        zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${opfName}" media-type="application/oebps-package+xml"/></rootfiles></container>`);
        zip.file(opfName, opfXml);

        for (let [relPath, content] of fileMap.entries()) {
            if (relPath !== opfName) {
                zip.file(relPath, content);
            }
        }

        try {
            let blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 9 } });
            let safeName = bookInfo.title.replace(/[\\/:*?"<>|]/g, "_");

            let a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = safeName + ".epub";
            a.click();

            SakiProgress.setPercent(100);
            SakiProgress.setText(`下载完成: ${safeName}.epub`);
            setTimeout(() => SakiProgress.hideDiv(), 5000);
        } catch (e) {
            SakiProgress.setText("❌ 打包失败: " + e.message);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { extractOfficialData(); SakiProgress.init(); });
    } else {
        extractOfficialData(); SakiProgress.init();
    }
})();
