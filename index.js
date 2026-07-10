import { extension_settings, getContext } from "../../../extensions.js";
import { getRequestHeaders, saveSettingsDebounced } from "../../../../script.js";

const MODULE = "chatsy_novel_export";
const SIGNATURE = "Chatsy Novel Export";
const BOUNDARY_MARK = "· · ·";

const defaultSettings = {
    patterns: ["```md[\\s\\S]*?```", "<Cot>[\\s\\S]*?</Cot>"],
    deleteKeywords: ["MEDIA / AUX"],
    missingTranslationMode: "blank", // blank | skip | warn
    overlapWindow: 30,
    showBoundary: true,
    outputs: { txtOrig: true, txtTrans: true, epubOrig: false, epubTrans: false },
};

function loadSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(defaultSettings);
    }
    const s = extension_settings[MODULE];
    for (const key of Object.keys(defaultSettings)) {
        if (s[key] === undefined) s[key] = structuredClone(defaultSettings[key]);
    }
    return s;
}

/* ---------------- 텍스트 처리 ---------------- */

function normalizeForCompare(text) {
    return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function stripTagsKeepText(html) {
    return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

// <div> 블록을 깊이 카운팅으로 정확히 찾아서, 삭제 키워드가 포함된 블록은 통째로 제거,
// 그 외 블록은 태그만 벗기고 텍스트(문자메시지 내용 등)는 보존한다.
function processHtmlDivBlocks(text, deleteKeywords) {
    if (!text) return text;
    let out = "";
    let i = 0;
    while (i < text.length) {
        const openIdx = text.indexOf("<div", i);
        if (openIdx === -1) { out += text.slice(i); break; }
        out += text.slice(i, openIdx);

        let depth = 1;
        let pos = openIdx + 4;
        while (depth > 0 && pos < text.length) {
            const nextOpen = text.indexOf("<div", pos);
            const nextClose = text.indexOf("</div>", pos);
            if (nextClose === -1) { pos = text.length; depth = 0; break; }
            if (nextOpen !== -1 && nextOpen < nextClose) { depth++; pos = nextOpen + 4; }
            else { depth--; pos = nextClose + 6; }
        }

        const block = text.slice(openIdx, pos);
        const shouldDelete = deleteKeywords.some(k => k && block.includes(k));
        if (!shouldDelete) out += stripTagsKeepText(block);
        i = pos;
    }
    return out.trim();
}

function applyRegexPatterns(text, patterns) {
    let out = text || "";
    for (const p of patterns) {
        try {
            out = out.replace(new RegExp(p, "g"), "");
        } catch (e) {
            console.warn("[Chatsy] 잘못된 정규식 무시:", p);
        }
    }
    return out.trim();
}

function cleanMessageText(text, settings) {
    let out = processHtmlDivBlocks(text, settings.deleteKeywords);
    out = applyRegexPatterns(out, settings.patterns);
    return out;
}

/* ---------------- 중복 탐지/병합 ---------------- */

function findOverlapLength(prevMessages, nextMessages, window) {
    const tail = prevMessages.slice(-window).map(m => normalizeForCompare(m.mes));
    const head = nextMessages.slice(0, window).map(m => normalizeForCompare(m.mes));
    let bestLen = 0;
    for (let start = 0; start < tail.length; start++) {
        const candidate = tail.slice(start);
        let matchLen = 0;
        for (let i = 0; i < candidate.length && i < head.length; i++) {
            if (candidate[i] === head[i] && candidate[i].length > 0) matchLen++;
            else break;
        }
        if (matchLen > bestLen) bestLen = matchLen;
    }
    return bestLen;
}

function mergeChatsWithDedup(fileMessageArrays, window) {
    if (fileMessageArrays.length === 0) return { merged: [], overlapReport: [], boundaryIndices: [] };
    let merged = [...fileMessageArrays[0]];
    const overlapReport = [];
    const boundaryIndices = [];
    for (let i = 1; i < fileMessageArrays.length; i++) {
        const next = fileMessageArrays[i];
        const overlapLen = findOverlapLength(merged, next, window);
        overlapReport.push({ fileIndex: i, overlapLen });
        boundaryIndices.push(merged.length);
        merged = merged.concat(next.slice(overlapLen));
    }
    return { merged, overlapReport, boundaryIndices };
}

/* ---------------- 출력 생성 ---------------- */

function buildOutputs(messages, settings, boundaryIndices) {
    let orig = [], trans = [];
    let missingCount = 0;
    const boundarySet = new Set(boundaryIndices || []);

    messages.forEach((msg, idx) => {
        if (settings.showBoundary && boundarySet.has(idx)) {
            orig.push(BOUNDARY_MARK);
            trans.push(BOUNDARY_MARK);
        }

        const speaker = msg.name || (msg.is_user ? "User" : "Character");
        const rawOrig = cleanMessageText(msg.mes, settings);

        if (msg.is_user) {
            // 사용자가 직접 입력한 메시지는 이미 원래 쓴 언어 그대로이므로 번역 개념이 적용되지 않음
            orig.push(`${speaker}: ${rawOrig}`);
            trans.push(`${speaker}: ${rawOrig}`);
            return;
        }

        orig.push(`${speaker}: ${rawOrig}`);

        const hasTranslation = !!(msg.extra && typeof msg.extra.display_text === "string" && msg.extra.display_text.length > 0);
        if (hasTranslation) {
            trans.push(`${speaker}: ${cleanMessageText(msg.extra.display_text, settings)}`);
        } else {
            missingCount++;
            if (settings.missingTranslationMode === "blank") trans.push(`${speaker}: [번역 없음]`);
            else if (settings.missingTranslationMode === "skip") { /* 생략 */ }
            else trans.push(`${speaker}: ${rawOrig} (⚠ 미번역, 원문)`);
        }
    });

    orig.push(`\n${SIGNATURE}`);
    trans.push(`\n${SIGNATURE}`);

    return { original: orig.join("\n\n"), translated: trans.join("\n\n"), missingCount };
}

function escapeXml(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function buildEpub(title, bodyText, coverBytes, coverMime) {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

    const uuid = "urn:uuid:" + "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });

    let coverManifest = "", coverMeta = "", coverSpineItem = "";
    if (coverBytes) {
        const mime = coverMime || "image/png";
        const ext = mime === "image/jpeg" ? "jpg" : "png";
        zip.file(`OEBPS/images/cover.${ext}`, coverBytes);
        coverManifest = `<item id="cover-image" href="images/cover.${ext}" media-type="${mime}" properties="cover-image"/>
    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>`;
        coverMeta = `<meta name="cover" content="cover-image"/>`;
        coverSpineItem = `<itemref idref="cover-page" linear="yes"/>`;
        zip.file("OEBPS/cover.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title></head>
<body style="text-align:center; margin:0; padding:0;">
  <img src="images/cover.${ext}" alt="cover" style="max-width:100%; max-height:100vh;"/>
</body>
</html>`);
    }

    zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${uuid}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>ko</dc:language>
    ${coverMeta}
  </metadata>
  <manifest>
    ${coverManifest}
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    ${coverSpineItem}
    <itemref idref="chapter1" linear="yes"/>
  </spine>
</package>`);

    zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Nav</title></head>
<body>
  <nav epub:type="toc"><ol><li><a href="text/chapter1.xhtml">${escapeXml(title)}</a></li></ol></nav>
</body>
</html>`);

    const paragraphs = bodyText.split("\n\n").map(p => `<p>${escapeXml(p).replace(/\n/g, "<br/>")}</p>`).join("\n");
    zip.file("OEBPS/text/chapter1.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(title)}</title></head>
<body>
${paragraphs}
</body>
</html>`);

    return zip.generateAsync({ type: "blob", mimeType: "application/epub+zip" });
}

/* ---------------- ST API ---------------- */

function getCurrentCharacter() {
    const context = getContext();
    const charId = context.characterId;
    if (charId === undefined || charId === null) return null;
    const character = context.characters[charId];
    if (!character) return null;
    return { name: character.name, avatar: character.avatar };
}

async function fetchChatList(avatarFile) {
    const res = await fetch("/api/characters/chats", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatarFile }),
    });
    if (!res.ok) throw new Error("챗 목록을 가져오지 못했어 (status " + res.status + ")");
    return res.json();
}

async function fetchChatContentRaw(chName, fileName, avatarFile) {
    const res = await fetch("/api/chats/get", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ ch_name: chName, file_name: fileName, avatar_url: avatarFile }),
    });
    if (!res.ok) throw new Error(`'${fileName}' 챗 내용을 가져오지 못했어 (status ${res.status})`);
    return res.json();
}

async function fetchChatContent(chName, fileName, avatarFile) {
    const first = await fetchChatContentRaw(chName, fileName, avatarFile);
    if (Array.isArray(first) && first.length > 0) return first;
    const altName = fileName.toLowerCase().endsWith(".jsonl") ? fileName.slice(0, -".jsonl".length) : fileName + ".jsonl";
    console.warn(`[Chatsy] '${fileName}' 응답 비어서 '${altName}'로 재시도`);
    return fetchChatContentRaw(chName, altName, avatarFile);
}

async function fetchAvatarBytes(avatarFile) {
    try {
        const url = `/thumbnail?type=avatar&file=${encodeURIComponent(avatarFile)}`;
        const res = await fetch(url, { headers: getRequestHeaders() });
        if (!res.ok) throw new Error("avatar fetch failed " + res.status);
        return await res.arrayBuffer();
    } catch (e) {
        console.warn("[Chatsy] 아바타 이미지 못 가져옴:", e);
        return null;
    }
}

function safeFileName(name) {
    return (name || "novel").replace(/[\\/:*?"<>|]/g, "_").replace(/\.jsonl$/i, "");
}

function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
function downloadText(filename, text) {
    downloadBlob(filename, new Blob([text], { type: "text/plain;charset=utf-8" }));
}

/* ---------------- 커버 이미지 (수동 선택 vs 아바타 자동) ---------------- */

let manualCoverFile = null; // 세션 동안만 유지 (새로고침하면 초기화, 매번 다시 골라도 됨)

function renderCoverPreview() {
    const preview = document.getElementById("chatsy_cover_preview");
    if (!preview) return;
    preview.innerHTML = "";
    if (manualCoverFile) {
        const img = document.createElement("img");
        img.src = URL.createObjectURL(manualCoverFile);
        img.style.maxWidth = "100px";
        img.style.borderRadius = "6px";
        img.style.display = "block";
        preview.appendChild(img);
        const cap = document.createElement("small");
        cap.textContent = "직접 선택한 커버: " + manualCoverFile.name;
        preview.appendChild(cap);
    } else {
        const cap = document.createElement("small");
        cap.textContent = "커버 미선택 → 캐릭터 아바타 자동 사용";
        preview.appendChild(cap);
    }
}

async function resolveCoverImage(character) {
    if (manualCoverFile) {
        const bytes = await manualCoverFile.arrayBuffer();
        const mime = manualCoverFile.type || (manualCoverFile.name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");
        return { bytes, mime };
    }
    const bytes = await fetchAvatarBytes(character.avatar);
    return { bytes, mime: "image/png" };
}

/* ---------------- 실행 흐름 ---------------- */

async function startExportFlow(settings) {
    const character = getCurrentCharacter();
    if (!character) { toastr.warning("현재 열려있는 캐릭터가 없어."); return; }

    toastr.info("챗 목록 가져오는 중...");
    let list;
    try {
        list = await fetchChatList(character.avatar);
    } catch (e) {
        toastr.error("챗 목록 실패: " + e.message);
        return;
    }
    if (!list || list.length === 0) { toastr.warning("이 캐릭터의 챗 파일이 없어."); return; }

    renderChatCheckList(list, character, settings);
}

function renderChatCheckList(list, character, settings) {
    const area = document.getElementById("chatsy_chatlist_area");
    area.innerHTML = "";

    const info = document.createElement("small");
    info.textContent = `${character.name}의 챗 파일 ${list.length}개. 소설로 묶을 것만 선택해줘.`;
    area.appendChild(info);

    const listWrap = document.createElement("div");
    listWrap.style.maxHeight = "180px";
    listWrap.style.overflow = "auto";
    listWrap.style.border = "1px solid #444";
    listWrap.style.borderRadius = "6px";
    listWrap.style.padding = "6px";
    listWrap.style.margin = "6px 0";

    list.forEach((entry, idx) => {
        const row = document.createElement("label");
        row.style.display = "block";
        row.style.fontWeight = "normal";
        row.style.fontSize = ".85em";
        row.innerHTML = `<input type="checkbox" class="chatsy-chat-check" data-idx="${idx}" checked style="width:auto; margin-right:6px;"> ${entry.file_name}`;
        listWrap.appendChild(row);
    });
    area.appendChild(listWrap);

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "menu_button";
    confirmBtn.textContent = "선택한 챗으로 추출 실행";
    confirmBtn.onclick = () => runExport(list, character, settings);
    area.appendChild(confirmBtn);
}

async function runExport(list, character, settings) {
    const checks = Array.from(document.querySelectorAll(".chatsy-chat-check"));
    const selected = checks.filter(c => c.checked).map(c => list[parseInt(c.dataset.idx, 10)]);
    if (selected.length === 0) { toastr.warning("최소 하나는 선택해줘."); return; }

    // 파일명 기준 정렬 (오래된 것 -> 최신 순으로 병합)
    selected.sort((a, b) => a.file_name.localeCompare(b.file_name, undefined, { numeric: true }));

    toastr.info(`챗 ${selected.length}개 불러오는 중...`);
    const fileMessageArrays = [];
    for (const entry of selected) {
        try {
            const messages = await fetchChatContent(character.name, entry.file_name, character.avatar);
            fileMessageArrays.push(Array.isArray(messages) ? messages.filter(m => typeof m.mes === "string") : []);
        } catch (e) {
            console.error(e);
            toastr.error(`'${entry.file_name}' 불러오기 실패: ${e.message}`);
            fileMessageArrays.push([]);
        }
    }

    const { merged, overlapReport, boundaryIndices } = mergeChatsWithDedup(fileMessageArrays, settings.overlapWindow);
    overlapReport.forEach(r => console.log(`[Chatsy] 파일 ${r.fileIndex + 1}: 겹침 ${r.overlapLen}개 제거`));

    const { original, translated, missingCount } = buildOutputs(merged, settings, boundaryIndices);
    if (missingCount > 0) toastr.info(`번역 없는 메시지 ${missingCount}개 (설정된 방식으로 처리됨)`);

    const baseName = safeFileName(character.name);
    const out = settings.outputs;

    if (out.txtOrig) downloadText(`${baseName}_original.txt`, original);
    if (out.txtTrans) downloadText(`${baseName}_translated.txt`, translated);

    if (out.epubOrig || out.epubTrans) {
        if (typeof JSZip === "undefined") {
            toastr.error("JSZip 로드 실패로 epub을 만들 수 없어.");
        } else {
            const { bytes: coverBytes, mime: coverMime } = await resolveCoverImage(character);
            if (out.epubOrig) {
                const blob = await buildEpub(baseName, original, coverBytes, coverMime);
                downloadBlob(`${baseName}_original.epub`, blob);
            }
            if (out.epubTrans) {
                const blob = await buildEpub(baseName, translated, coverBytes, coverMime);
                downloadBlob(`${baseName}_translated.epub`, blob);
            }
        }
    }

    toastr.success(`총 메시지 ${merged.length}개로 추출 완료!`);
}

/* ---------------- 설정 UI ---------------- */

function addPatternRow(container, value) {
    const row = document.createElement("div");
    row.className = "chatsy-row";
    row.innerHTML = `<input type="text" class="chatsy-pattern-input text_pole" value="${(value || "").replace(/"/g, "&quot;")}">
                      <button type="button" class="menu_button chatsy-small">삭제</button>`;
    row.querySelector("button").onclick = () => row.remove();
    container.appendChild(row);
}

function addKeywordRow(container, value) {
    const row = document.createElement("div");
    row.className = "chatsy-row";
    row.innerHTML = `<input type="text" class="chatsy-keyword-input text_pole" placeholder="예: MEDIA / AUX" value="${(value || "").replace(/"/g, "&quot;")}">
                      <button type="button" class="menu_button chatsy-small">삭제</button>`;
    row.querySelector("button").onclick = () => row.remove();
    container.appendChild(row);
}

function buildSettingsHtml() {
    return `
    <div id="chatsy_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>📖 Chatsy Novel Export</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <label>제거할 패턴 (정규식, 원문/번역 양쪽에 적용)</label>
                <div id="chatsy_patterns"></div>
                <button type="button" class="menu_button chatsy-small" id="chatsy_add_pattern">+ 패턴 추가</button>

                <label style="margin-top:10px;">완전삭제 키워드 (이 단어가 포함된 &lt;div&gt; 블록은 통째로 삭제)</label>
                <div id="chatsy_keywords"></div>
                <button type="button" class="menu_button chatsy-small" id="chatsy_add_keyword">+ 키워드 추가</button>

                <label style="margin-top:10px;">번역 없는 메시지 처리</label>
                <select id="chatsy_missing_mode" class="text_pole">
                    <option value="blank">[번역 없음] 표시</option>
                    <option value="skip">번역본에서 생략</option>
                    <option value="warn">원문 대체 + ⚠ 표시</option>
                </select>

                <label>중복 탐지 범위 (마지막/처음 몇 개 메시지 비교)</label>
                <input type="number" id="chatsy_window" class="text_pole" min="5" max="300">

                <label><input type="checkbox" id="chatsy_show_boundary" style="width:auto; margin-right:6px;"> 파일 전환 지점에 구분자(· · ·) 표시</label>

                <label style="margin-top:10px;">출력할 파일</label>
                <label><input type="checkbox" id="chatsy_out_txt_orig" style="width:auto; margin-right:6px;"> txt 원문</label>
                <label><input type="checkbox" id="chatsy_out_txt_trans" style="width:auto; margin-right:6px;"> txt 번역</label>
                <label><input type="checkbox" id="chatsy_out_epub_orig" style="width:auto; margin-right:6px;"> epub 원문</label>
                <label><input type="checkbox" id="chatsy_out_epub_trans" style="width:auto; margin-right:6px;"> epub 번역</label>

                <label style="margin-top:10px;">epub 커버 이미지</label>
                <small>직접 이미지를 선택하면 그걸 쓰고, 선택 안 하면 캐릭터 아바타를 자동으로 사용해.</small>
                <input type="file" id="chatsy_cover_file" accept="image/png,image/jpeg,image/jpg">
                <div id="chatsy_cover_preview" style="margin:6px 0;"></div>
                <button type="button" id="chatsy_clear_cover" class="menu_button chatsy-small">아바타로 되돌리기</button>

                <button id="chatsy_run" class="menu_button" style="width:100%; margin-top:14px;">📖 소설로 추출</button>
                <div id="chatsy_chatlist_area" style="margin-top:10px;"></div>
            </div>
        </div>
    </div>`;
}

function bindSettingsUi(settings) {
    const patternsWrap = document.getElementById("chatsy_patterns");
    settings.patterns.forEach(p => addPatternRow(patternsWrap, p));
    document.getElementById("chatsy_add_pattern").onclick = () => addPatternRow(patternsWrap, "");

    const keywordsWrap = document.getElementById("chatsy_keywords");
    settings.deleteKeywords.forEach(k => addKeywordRow(keywordsWrap, k));
    document.getElementById("chatsy_add_keyword").onclick = () => addKeywordRow(keywordsWrap, "");

    document.getElementById("chatsy_missing_mode").value = settings.missingTranslationMode;
    document.getElementById("chatsy_window").value = settings.overlapWindow;
    document.getElementById("chatsy_show_boundary").checked = settings.showBoundary;
    document.getElementById("chatsy_out_txt_orig").checked = settings.outputs.txtOrig;
    document.getElementById("chatsy_out_txt_trans").checked = settings.outputs.txtTrans;
    document.getElementById("chatsy_out_epub_orig").checked = settings.outputs.epubOrig;
    document.getElementById("chatsy_out_epub_trans").checked = settings.outputs.epubTrans;

    function syncSettingsFromUi() {
        settings.patterns = Array.from(document.querySelectorAll(".chatsy-pattern-input")).map(i => i.value.trim()).filter(Boolean);
        settings.deleteKeywords = Array.from(document.querySelectorAll(".chatsy-keyword-input")).map(i => i.value.trim()).filter(Boolean);
        settings.missingTranslationMode = document.getElementById("chatsy_missing_mode").value;
        settings.overlapWindow = parseInt(document.getElementById("chatsy_window").value, 10) || defaultSettings.overlapWindow;
        settings.showBoundary = document.getElementById("chatsy_show_boundary").checked;
        settings.outputs = {
            txtOrig: document.getElementById("chatsy_out_txt_orig").checked,
            txtTrans: document.getElementById("chatsy_out_txt_trans").checked,
            epubOrig: document.getElementById("chatsy_out_epub_orig").checked,
            epubTrans: document.getElementById("chatsy_out_epub_trans").checked,
        };
        saveSettingsDebounced();
    }

    document.getElementById("chatsy_settings").addEventListener("change", syncSettingsFromUi);
    document.getElementById("chatsy_run").addEventListener("click", () => {
        syncSettingsFromUi();
        startExportFlow(settings);
    });

    document.getElementById("chatsy_cover_file").addEventListener("change", (e) => {
        manualCoverFile = e.target.files[0] || null;
        renderCoverPreview();
    });
    document.getElementById("chatsy_clear_cover").addEventListener("click", () => {
        manualCoverFile = null;
        document.getElementById("chatsy_cover_file").value = "";
        renderCoverPreview();
    });
    renderCoverPreview();
}

/* ---------------- 초기화 ---------------- */

if (typeof JSZip === "undefined") {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    document.head.appendChild(script);
}

jQuery(async () => {
    const settings = loadSettings();
    const container = document.createElement("div");
    container.innerHTML = buildSettingsHtml();
    document.getElementById("extensions_settings").appendChild(container);
    bindSettingsUi(settings);
});
