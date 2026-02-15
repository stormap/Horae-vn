/**
 * Horae - Plugin Ký ức Thời gian
 * Hệ thống tăng cường trí nhớ AI dựa trên các mốc thời gian
 * * Tác giả: SenriYuki
 * Phiên bản: 1.0.0
 */

import { renderExtensionTemplateAsync, getContext, extension_settings } from '/scripts/extensions.js';
import { getSlideToggleOptions, saveSettingsDebounced, eventSource, event_types } from '/script.js';
import { slideToggle } from '/lib.js';

import { horaeManager, createEmptyMeta } from './core/horaeManager.js';
import { calculateRelativeTime, calculateDetailedRelativeTime, formatRelativeTime, generateTimeReference, getCurrentSystemTime, formatStoryDate, formatFullDateTime, parseStoryDate } from './utils/timeUtils.js';

// ============================================
// Định nghĩa Hằng số
// ============================================
const EXTENSION_NAME = 'horae';
const EXTENSION_FOLDER = `third-party/SillyTavern-Horae`;
const TEMPLATE_PATH = `${EXTENSION_FOLDER}/assets/templates`;
const VERSION = '1.0.0';

// Các quy tắc Regex đi kèm (Tự động tiêm vào hệ thống regex gốc của ST)
const HORAE_REGEX_RULES = [
    {
        id: 'horae_hide',
        scriptName: 'Horae - Ẩn thẻ trạng thái',
        description: 'Ẩn thẻ trạng thái <horae>, không hiển thị trong nội dung chính, không gửi cho AI',
        findRegex: '/(?:<horae>[\\s\\S]*?<\\/horae>||(?:^|\\n)(?:time|location|atmosphere|characters|costume|item-?!{0,2}|affection|npc|agenda-?):[^\\n]+(?:\\n(?:time|location|atmosphere|characters|costume|item-?!{0,2}|affection|npc|agenda-?):[^\\n]+)*)/gim',
        replaceString: '',
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: true,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    },
    {
        id: 'horae_event_display_only',
        scriptName: 'Horae - Ẩn thẻ sự kiện',
        description: 'Ẩn hiển thị thẻ sự kiện <horaeevent>, nhưng vẫn gửi cho AI để truy xuất cốt truyện',
        findRegex: '/<horaeevent>[\\s\\S]*?<\\/horaeevent>/gim',
        replaceString: '',
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    },
    {
        id: 'horae_table_hide',
        scriptName: 'Horae - Ẩn thẻ bảng',
        description: 'Ẩn thẻ <horaetable>, không hiển thị trong nội dung chính, không gửi cho AI',
        findRegex: '/<horaetable[:\\uff1a][\\s\\S]*?<\\/horaetable>/gim',
        replaceString: '',
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: true,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    },
];

// ============================================
// Cài đặt mặc định
// ============================================
const DEFAULT_SETTINGS = {
    enabled: true,
    autoParse: true,
    injectContext: true,
    showMessagePanel: true,
    contextDepth: 15,
    injectionPosition: 1,
    lastStoryDate: '',
    lastStoryTime: '',
    favoriteNpcs: [],  // Danh sách NPC được đánh dấu sao bởi người dùng
    pinnedNpcs: [],    // Danh sách nhân vật quan trọng được người dùng đánh dấu thủ công (viền đặc biệt)
    // Kiểm soát nội dung gửi cho AI
    sendTimeline: true,    // Gửi dòng thời gian cốt truyện (tắt sẽ không tính được thời gian tương đối)
    sendCharacters: true,  // Gửi thông tin nhân vật (trang phục, độ hảo cảm)
    sendItems: true,       // Gửi kho đồ
    customTables: []       // Bảng tùy chỉnh [{id, name, rows, cols, data, prompt}]
};

// ============================================
// Biến toàn cục
// ============================================
let settings = { ...DEFAULT_SETTINGS };
let doNavbarIconClick = null;
let isInitialized = false;
let itemsMultiSelectMode = false;  // Chế độ đa chọn vật phẩm
let selectedItems = new Set();     // Tên các vật phẩm đã chọn
let longPressTimer = null;         // Bộ đếm thời gian nhấn giữ
let agendaMultiSelectMode = false; // Chế độ đa chọn việc cần làm
let selectedAgendaIndices = new Set(); // Chỉ mục việc cần làm đã chọn
let agendaLongPressTimer = null;   // Bộ đếm thời gian nhấn giữ việc cần làm

// ============================================
// Hàm tiện ích
// ============================================

/** Tự động tiêm các regex đi kèm vào hệ thống regex gốc của ST (Tự động thực hiện khi cài đặt lần đầu, người dùng có thể quản lý trong bảng regex) */
function ensureRegexRules() {
    if (!extension_settings.regex) extension_settings.regex = [];

    let injected = 0;
    for (const rule of HORAE_REGEX_RULES) {
        const idx = extension_settings.regex.findIndex(r => r.id === rule.id);
        if (idx === -1) {
            extension_settings.regex.push({ ...rule });
            injected++;
        } else {
            // Nếu đã tồn tại thì đồng bộ cập nhật nội dung regex (tự động sửa khi nâng cấp phiên bản), giữ nguyên trạng thái disabled của người dùng
            const userDisabled = extension_settings.regex[idx].disabled;
            extension_settings.regex[idx] = { ...rule, disabled: userDisabled };
        }
    }

    if (injected > 0) {
        saveSettingsDebounced();
        console.log(`[Horae] Đã tự động tiêm ${injected} quy tắc regex đi kèm`);
    }
}

/** Lấy mẫu HTML */
async function getTemplate(name) {
    return await renderExtensionTemplateAsync(TEMPLATE_PATH, name);
}

/**
 * Kiểm tra xem có phải phiên bản thanh điều hướng mới không
 */
function isNewNavbarVersion() {
    return typeof doNavbarIconClick === 'function';
}

/**
 * Khởi tạo chức năng click thanh điều hướng
 */
async function initNavbarFunction() {
    try {
        const scriptModule = await import('/script.js');
        if (scriptModule.doNavbarIconClick) {
            doNavbarIconClick = scriptModule.doNavbarIconClick;
        }
    } catch (error) {
        console.warn(`[Horae] doNavbarIconClick không khả dụng, sử dụng chế độ ngăn kéo cũ`);
    }
}

/**
 * Tải cài đặt
 */
function loadSettings() {
    if (extension_settings[EXTENSION_NAME]) {
        settings = { ...DEFAULT_SETTINGS, ...extension_settings[EXTENSION_NAME] };
    } else {
        extension_settings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
    }
}

/**
 * Lưu cài đặt
 */
function saveSettings() {
    extension_settings[EXTENSION_NAME] = settings;
    saveSettingsDebounced();
}

/**
 * Hiển thị thông báo Toast
 */
function showToast(message, type = 'info') {
    if (window.toastr) {
        toastr[type](message, 'Horae');
    } else {
        console.log(`[Horae] ${type}: ${message}`);
    }
}

/** Lấy các bảng tùy chỉnh của cuộc trò chuyện hiện tại */
function getChatTables() {
    const context = getContext();
    if (!context?.chat?.length) return [];
    
    const firstMessage = context.chat[0];
    if (firstMessage?.horae_meta?.customTables) {
        return firstMessage.horae_meta.customTables;
    }
    
    // Tương thích cũ: kiểm tra thuộc tính mảng chat
    if (context.chat.horae_tables) {
        return context.chat.horae_tables;
    }
    
    return [];
}

/** Đặt các bảng tùy chỉnh cho cuộc trò chuyện hiện tại */
function setChatTables(tables) {
    const context = getContext();
    if (!context?.chat?.length) return;
    
    if (!context.chat[0].horae_meta) {
        context.chat[0].horae_meta = createEmptyMeta();
    }
    
    // Snapshot baseData để hoàn tác
    for (const table of tables) {
        table.baseData = JSON.parse(JSON.stringify(table.data || {}));
        table.baseRows = table.rows || 2;
        table.baseCols = table.cols || 2;
    }
    
    context.chat[0].horae_meta.customTables = tables;
    getContext().saveChat();
}

// ============================================
// Lưu trữ Việc cần làm (Agenda) — Theo cuộc trò chuyện hiện tại
// ============================================

/**
 * Lấy việc cần làm do người dùng tạo thủ công (lưu trong chat[0])
 */
function getUserAgenda() {
    const context = getContext();
    if (!context?.chat?.length) return [];
    
    const firstMessage = context.chat[0];
    if (firstMessage?.horae_meta?.agenda) {
        return firstMessage.horae_meta.agenda;
    }
    return [];
}

/**
 * Đặt việc cần làm do người dùng tạo thủ công (lưu trong chat[0])
 */
function setUserAgenda(agenda) {
    const context = getContext();
    if (!context?.chat?.length) return;
    
    if (!context.chat[0].horae_meta) {
        context.chat[0].horae_meta = createEmptyMeta();
    }
    
    context.chat[0].horae_meta.agenda = agenda;
    getContext().saveChat();
}

/**
 * Lấy tất cả việc cần làm (Người dùng + AI ghi), trả về định dạng thống nhất
 * Mỗi mục: { text, date, source: 'user'|'ai', done, createdAt, _msgIndex? }
 */
function getAllAgenda() {
    const all = [];
    
    // 1. Người dùng tạo thủ công
    const userItems = getUserAgenda();
    for (const item of userItems) {
        all.push({
            text: item.text,
            date: item.date || '',
            source: item.source || 'user',
            done: !!item.done,
            createdAt: item.createdAt || 0,
            _store: 'user',
            _index: all.length
        });
    }
    
    // 2. AI ghi (lưu trong horae_meta.agenda của từng tin nhắn)
    const context = getContext();
    if (context?.chat) {
        for (let i = 1; i < context.chat.length; i++) {
            const meta = context.chat[i].horae_meta;
            if (meta?.agenda?.length > 0) {
                for (const item of meta.agenda) {
                    // Khử trùng lặp: kiểm tra xem nội dung đã tồn tại chưa
                    const isDupe = all.some(a => a.text === item.text);
                    if (!isDupe) {
                        all.push({
                            text: item.text,
                            date: item.date || '',
                            source: 'ai',
                            done: !!item.done,
                            createdAt: item.createdAt || 0,
                            _store: 'msg',
                            _msgIndex: i,
                            _index: all.length
                        });
                    }
                }
            }
        }
    }
    
    return all;
}

/**
 * Chuyển đổi trạng thái hoàn thành của việc cần làm dựa trên chỉ mục toàn cục
 */
function toggleAgendaDone(agendaItem, done) {
    const context = getContext();
    if (!context?.chat) return;
    
    if (agendaItem._store === 'user') {
        const agenda = getUserAgenda();
        // Tìm theo text (đáng tin cậy hơn)
        const found = agenda.find(a => a.text === agendaItem.text);
        if (found) {
            found.done = done;
            setUserAgenda(agenda);
        }
    } else if (agendaItem._store === 'msg') {
        const msg = context.chat[agendaItem._msgIndex];
        if (msg?.horae_meta?.agenda) {
            const found = msg.horae_meta.agenda.find(a => a.text === agendaItem.text);
            if (found) {
                found.done = done;
                getContext().saveChat();
            }
        }
    }
}

/**
 * Xóa việc cần làm được chỉ định
 */
function deleteAgendaItem(agendaItem) {
    const context = getContext();
    if (!context?.chat) return;
    
    if (agendaItem._store === 'user') {
        const agenda = getUserAgenda();
        const idx = agenda.findIndex(a => a.text === agendaItem.text);
        if (idx !== -1) {
            agenda.splice(idx, 1);
            setUserAgenda(agenda);
        }
    } else if (agendaItem._store === 'msg') {
        const msg = context.chat[agendaItem._msgIndex];
        if (msg?.horae_meta?.agenda) {
            const idx = msg.horae_meta.agenda.findIndex(a => a.text === agendaItem.text);
            if (idx !== -1) {
                msg.horae_meta.agenda.splice(idx, 1);
                getContext().saveChat();
            }
        }
    }
}

/**
 * Xuất bảng dưới dạng JSON
 */
function exportTable(tableIndex) {
    const tables = getChatTables();
    const table = tables[tableIndex];
    if (!table) return;
    
    const exportData = JSON.stringify(table, null, 2);
    const blob = new Blob([exportData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `horae_table_${table.name || tableIndex}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
    showToast('Đã xuất bảng', 'success');
}

/**
 * Nhập bảng
 */
function importTable(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const tableData = JSON.parse(e.target.result);
            if (!tableData || typeof tableData !== 'object') {
                throw new Error('Dữ liệu bảng không hợp lệ');
            }
            
            // Đảm bảo có các trường cần thiết
            const newTable = {
                id: Date.now().toString(),
                name: tableData.name || 'Bảng đã nhập',
                rows: tableData.rows || 2,
                cols: tableData.cols || 2,
                data: tableData.data || {},
                prompt: tableData.prompt || ''
            };
            
            const tables = getChatTables();
            tables.push(newTable);
            setChatTables(tables);
            
            renderCustomTablesList();
            showToast('Đã nhập bảng', 'success');
        } catch (err) {
            showToast('Nhập thất bại: ' + err.message, 'error');
        }
    };
    reader.readAsText(file);
}

// ============================================
// Hàm render UI
// ============================================

/**
 * Cập nhật hiển thị trang trạng thái
 */
function updateStatusDisplay() {
    const state = horaeManager.getLatestState();
    
    // Cập nhật hiển thị thời gian (lịch tiêu chuẩn hiển thị thứ)
    const dateEl = document.getElementById('horae-current-date');
    const timeEl = document.getElementById('horae-current-time');
    if (dateEl) {
        const dateStr = state.timestamp?.story_date || '--/--';
        const parsed = parseStoryDate(dateStr);
        // Lịch tiêu chuẩn thêm thứ
        if (parsed && parsed.type === 'standard') {
            dateEl.textContent = formatStoryDate(parsed, true);
        } else {
            dateEl.textContent = dateStr;
        }
    }
    if (timeEl) timeEl.textContent = state.timestamp?.story_time || '--:--';
    
    // Cập nhật hiển thị địa điểm
    const locationEl = document.getElementById('horae-current-location');
    if (locationEl) locationEl.textContent = state.scene?.location || 'Chưa thiết lập';
    
    // Cập nhật bầu không khí
    const atmosphereEl = document.getElementById('horae-current-atmosphere');
    if (atmosphereEl) atmosphereEl.textContent = state.scene?.atmosphere || '';
    
    // Cập nhật danh sách trang phục (chỉ hiển thị trang phục của nhân vật đang có mặt)
    const costumesEl = document.getElementById('horae-costumes-list');
    if (costumesEl) {
        const presentChars = state.scene?.characters_present || [];
        const allCostumes = Object.entries(state.costumes || {});
        // Lọc: Chỉ giữ lại các nhân vật có trong characters_present
        const entries = presentChars.length > 0
            ? allCostumes.filter(([char]) => presentChars.some(p => p === char || char.includes(p) || p.includes(char)))
            : allCostumes;
        if (entries.length === 0) {
            costumesEl.innerHTML = '<div class="horae-empty-hint">Chưa có ghi chép trang phục nhân vật</div>';
        } else {
            costumesEl.innerHTML = entries.map(([char, costume]) => `
                <div class="horae-costume-item">
                    <span class="horae-costume-char">${char}</span>
                    <span class="horae-costume-desc">${costume}</span>
                </div>
            `).join('');
        }
    }
    
    // Cập nhật danh sách nhanh vật phẩm
    const itemsEl = document.getElementById('horae-items-quick');
    if (itemsEl) {
        const entries = Object.entries(state.items || {});
        if (entries.length === 0) {
            itemsEl.innerHTML = '<div class="horae-empty-hint">Chưa có vật phẩm theo dõi</div>';
        } else {
            itemsEl.innerHTML = entries.map(([name, info]) => {
                const icon = info.icon || '📦';
                const holderStr = info.holder ? `<span class="holder">${info.holder}</span>` : '';
                const locationStr = info.location ? `<span class="location">@ ${info.location}</span>` : '';
                return `<div class="horae-item-tag">${icon} ${name} ${holderStr} ${locationStr}</div>`;
            }).join('');
        }
    }
}

/**
 * Cập nhật hiển thị dòng thời gian
 */
function updateTimelineDisplay() {
    const filterLevel = document.getElementById('horae-timeline-filter')?.value || 'all';
    const searchKeyword = (document.getElementById('horae-timeline-search')?.value || '').trim().toLowerCase();
    let events = horaeManager.getEvents(50, filterLevel);
    const listEl = document.getElementById('horae-timeline-list');
    
    if (!listEl) return;
    
    // Lọc theo từ khóa
    if (searchKeyword) {
        events = events.filter(e => {
            const summary = (e.event?.summary || '').toLowerCase();
            const date = (e.timestamp?.story_date || '').toLowerCase();
            const level = (e.event?.level || '').toLowerCase();
            return summary.includes(searchKeyword) || date.includes(searchKeyword) || level.includes(searchKeyword);
        });
    }
    
    if (events.length === 0) {
        const filterText = filterLevel === 'all' ? '' : `cấp độ 「${filterLevel}」`;
        const searchText = searchKeyword ? `có chứa 「${searchKeyword}」` : '';
        listEl.innerHTML = `
            <div class="horae-empty-state">
                <i class="fa-regular fa-clock"></i>
                <span>Chưa có bản ghi sự kiện ${searchText} ${filterText}</span>
            </div>
        `;
        return;
    }
    
    const state = horaeManager.getLatestState();
    const currentDate = state.timestamp?.story_date || getCurrentSystemTime().date;
    
    listEl.innerHTML = events.reverse().map(e => {
            const result = calculateDetailedRelativeTime(
            e.timestamp?.story_date || '',
            currentDate
        );
        const relTime = result.relative;
        const levelClass = e.event?.level === '关键' ? 'critical' : 
                          e.event?.level === '重要' ? 'important' : '';
        // Dịch level hiển thị
        let displayLevel = e.event?.level;
        if (displayLevel === '关键') displayLevel = 'Then chốt';
        if (displayLevel === '重要') displayLevel = 'Quan trọng';
        if (displayLevel === '一般') displayLevel = 'Bình thường';

        const levelBadge = e.event?.level ? `<span class="horae-level-badge ${levelClass}">${displayLevel}</span>` : '';
        
        // Lịch tiêu chuẩn hiển thị thứ
        const dateStr = e.timestamp?.story_date || '?';
        const parsed = parseStoryDate(dateStr);
        const displayDate = (parsed && parsed.type === 'standard') ? formatStoryDate(parsed, true) : dateStr;
        
        return `
            <div class="horae-timeline-item horae-editable-item ${levelClass}" data-message-id="${e.messageIndex}">
                <div class="horae-timeline-time">
                    <div class="date">${displayDate}</div>
                    <div>${e.timestamp?.story_time || ''}</div>
                </div>
                <div class="horae-timeline-content">
                    <div class="horae-timeline-summary">${levelBadge}${e.event?.summary || 'Chưa ghi chép'}</div>
                    <div class="horae-timeline-meta">${relTime} · Tin nhắn #${e.messageIndex}</div>
                </div>
                <button class="horae-item-edit-btn" data-edit-type="event" data-message-id="${e.messageIndex}" data-event-index="${e.eventIndex || 0}" title="Chỉnh sửa">
                    <i class="fa-solid fa-pen"></i>
                </button>
            </div>
        `;
    }).join('');
    
    listEl.querySelectorAll('.horae-timeline-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.horae-item-edit-btn')) return;
            const messageId = item.dataset.messageId;
            scrollToMessage(messageId);
        });
    });
    
    bindEditButtons();
}

/**
 * Cập nhật hiển thị việc cần làm
 */
function updateAgendaDisplay() {
    const listEl = document.getElementById('horae-agenda-list');
    if (!listEl) return;
    
    const agenda = getAllAgenda();
    
    if (agenda.length === 0) {
        listEl.innerHTML = '<div class="horae-empty-hint">Chưa có việc cần làm</div>';
        // Thoát chế độ đa chọn (nếu tất cả việc cần làm đã bị xóa)
        if (agendaMultiSelectMode) exitAgendaMultiSelect();
        return;
    }
    
    listEl.innerHTML = agenda.map((item, index) => {
        const sourceIcon = item.source === 'ai'
            ? '<i class="fa-solid fa-robot horae-agenda-source-ai" title="AI ghi chép"></i>'
            : '<i class="fa-solid fa-user horae-agenda-source-user" title="Người dùng thêm"></i>';
        const dateDisplay = item.date ? `<span class="horae-agenda-date"><i class="fa-regular fa-calendar"></i> ${escapeHtml(item.date)}</span>` : '';
        
        // Chế độ đa chọn: hiển thị checkbox
        const checkboxHtml = agendaMultiSelectMode
            ? `<label class="horae-agenda-select-check"><input type="checkbox" ${selectedAgendaIndices.has(index) ? 'checked' : ''} data-agenda-select="${index}"></label>`
            : '';
        const selectedClass = agendaMultiSelectMode && selectedAgendaIndices.has(index) ? ' selected' : '';
        
        return `
            <div class="horae-agenda-item${selectedClass}" data-agenda-idx="${index}">
                ${checkboxHtml}
                <div class="horae-agenda-body">
                    <div class="horae-agenda-meta">${sourceIcon}${dateDisplay}</div>
                    <div class="horae-agenda-text">${escapeHtml(item.text)}</div>
                </div>
            </div>
        `;
    }).join('');
    
    const currentAgenda = agenda;
    
    listEl.querySelectorAll('.horae-agenda-item').forEach(el => {
        const idx = parseInt(el.dataset.agendaIdx);
        
        if (agendaMultiSelectMode) {
            // Chế độ đa chọn: click để chuyển đổi chọn
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleAgendaSelection(idx);
            });
        } else {
            // Chế độ thường: click để sửa, nhấn giữ để vào đa chọn
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = currentAgenda[idx];
                if (item) openAgendaEditModal(item);
            });
            
            // Nhấn giữ để vào chế độ đa chọn (chỉ bind trên agenda item)
            el.addEventListener('mousedown', (e) => startAgendaLongPress(e, idx));
            el.addEventListener('touchstart', (e) => startAgendaLongPress(e, idx), { passive: true });
            el.addEventListener('mouseup', cancelAgendaLongPress);
            el.addEventListener('mouseleave', cancelAgendaLongPress);
            el.addEventListener('touchmove', cancelAgendaLongPress, { passive: true });
            el.addEventListener('touchend', cancelAgendaLongPress);
            el.addEventListener('touchcancel', cancelAgendaLongPress);
        }
    });
}

// ---- Chế độ đa chọn việc cần làm ----

function startAgendaLongPress(e, agendaIdx) {
    if (agendaMultiSelectMode) return;
    agendaLongPressTimer = setTimeout(() => {
        enterAgendaMultiSelect(agendaIdx);
    }, 800);
}

function cancelAgendaLongPress() {
    if (agendaLongPressTimer) {
        clearTimeout(agendaLongPressTimer);
        agendaLongPressTimer = null;
    }
}

function enterAgendaMultiSelect(initialIdx) {
    agendaMultiSelectMode = true;
    selectedAgendaIndices.clear();
    if (initialIdx !== undefined && initialIdx !== null) {
        selectedAgendaIndices.add(initialIdx);
    }
    
    const bar = document.getElementById('horae-agenda-multiselect-bar');
    if (bar) bar.style.display = 'flex';
    
    // Ẩn nút thêm
    const addBtn = document.getElementById('horae-btn-add-agenda');
    if (addBtn) addBtn.style.display = 'none';
    
    updateAgendaDisplay();
    updateAgendaSelectedCount();
    showToast('Đã vào chế độ đa chọn, nhấn để chọn việc cần làm', 'info');
}

function exitAgendaMultiSelect() {
    agendaMultiSelectMode = false;
    selectedAgendaIndices.clear();
    
    const bar = document.getElementById('horae-agenda-multiselect-bar');
    if (bar) bar.style.display = 'none';
    
    // Khôi phục nút thêm
    const addBtn = document.getElementById('horae-btn-add-agenda');
    if (addBtn) addBtn.style.display = '';
    
    updateAgendaDisplay();
}

function toggleAgendaSelection(idx) {
    if (selectedAgendaIndices.has(idx)) {
        selectedAgendaIndices.delete(idx);
    } else {
        selectedAgendaIndices.add(idx);
    }
    
    // Cập nhật UI của mục đó
    const item = document.querySelector(`#horae-agenda-list .horae-agenda-item[data-agenda-idx="${idx}"]`);
    if (item) {
        const cb = item.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = selectedAgendaIndices.has(idx);
        item.classList.toggle('selected', selectedAgendaIndices.has(idx));
    }
    
    updateAgendaSelectedCount();
}

function selectAllAgenda() {
    const items = document.querySelectorAll('#horae-agenda-list .horae-agenda-item');
    items.forEach(item => {
        const idx = parseInt(item.dataset.agendaIdx);
        if (!isNaN(idx)) selectedAgendaIndices.add(idx);
    });
    updateAgendaDisplay();
    updateAgendaSelectedCount();
}

function updateAgendaSelectedCount() {
    const countEl = document.getElementById('horae-agenda-selected-count');
    if (countEl) countEl.textContent = selectedAgendaIndices.size;
}

async function deleteSelectedAgenda() {
    if (selectedAgendaIndices.size === 0) {
        showToast('Chưa chọn việc cần làm nào', 'warning');
        return;
    }
    
    const confirmed = confirm(`Bạn có chắc muốn xóa ${selectedAgendaIndices.size} việc cần làm đã chọn không？\n\nThao tác này không thể hoàn tác.`);
    if (!confirmed) return;
    
    // Lấy danh sách agenda đầy đủ hiện tại, xóa theo thứ tự chỉ mục giảm dần
    const agenda = getAllAgenda();
    const sortedIndices = Array.from(selectedAgendaIndices).sort((a, b) => b - a);
    
    for (const idx of sortedIndices) {
        const item = agenda[idx];
        if (item) {
            deleteAgendaItem(item);
        }
    }
    
    await getContext().saveChat();
    showToast(`Đã xóa ${selectedAgendaIndices.size} việc cần làm`, 'success');
    
    exitAgendaMultiSelect();
}

/**
 * Mở popup thêm/sửa việc cần làm
 * @param {Object|null} agendaItem - Khi sửa thì truyền object agenda đầy đủ, khi thêm mới thì truyền null
 */
function openAgendaEditModal(agendaItem = null) {
    const isEdit = agendaItem !== null;
    const currentText = isEdit ? (agendaItem.text || '') : '';
    const currentDate = isEdit ? (agendaItem.date || '') : '';
    const title = isEdit ? 'Sửa việc cần làm' : 'Thêm việc cần làm';
    
    closeEditModal();
    
    const deleteBtn = isEdit ? `
                    <button id="agenda-modal-delete" class="menu_button danger">
                        <i class="fa-solid fa-trash"></i> Xóa
                    </button>` : '';
    
    const modalHtml = `
        <div id="horae-edit-modal" class="horae-modal">
            <div class="horae-modal-content">
                <div class="horae-modal-header">
                    <i class="fa-solid fa-list-check"></i> ${title}
                </div>
                <div class="horae-modal-body horae-edit-modal-body">
                    <div class="horae-edit-field">
                        <label>Ngày thiết lập (Không bắt buộc)</label>
                        <input type="text" id="agenda-edit-date" value="${escapeHtml(currentDate)}" placeholder="Ví dụ: 2026/02/10">
                    </div>
                    <div class="horae-edit-field">
                        <label>Nội dung</label>
                        <textarea id="agenda-edit-text" rows="3" placeholder="Nhập việc cần làm, thời gian tương đối vui lòng ghi chú thời gian tuyệt đối, ví dụ: Allen mời Alice hẹn hò vào tối Valentine (2026/02/14 18:00)">${escapeHtml(currentText)}</textarea>
                    </div>
                </div>
                <div class="horae-modal-footer">
                    <button id="agenda-modal-save" class="menu_button primary">
                        <i class="fa-solid fa-check"></i> Lưu
                    </button>
                    <button id="agenda-modal-cancel" class="menu_button">
                        <i class="fa-solid fa-xmark"></i> Hủy
                    </button>
                    ${deleteBtn}
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    preventModalBubble();
    
    setTimeout(() => {
        const textarea = document.getElementById('agenda-edit-text');
        if (textarea) textarea.focus();
    }, 100);
    
    document.getElementById('horae-edit-modal').addEventListener('click', (e) => {
        if (e.target.id === 'horae-edit-modal') closeEditModal();
    });
    
    document.getElementById('agenda-modal-save').addEventListener('click', (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        const text = document.getElementById('agenda-edit-text').value.trim();
        const date = document.getElementById('agenda-edit-date').value.trim();
        if (!text) {
            showToast('Nội dung không được để trống', 'warning');
            return;
        }
        
        if (isEdit) {
            // Sửa mục hiện có
            const context = getContext();
            if (agendaItem._store === 'user') {
                const agenda = getUserAgenda();
                const found = agenda.find(a => a.text === agendaItem.text);
                if (found) {
                    found.text = text;
                    found.date = date;
                }
                setUserAgenda(agenda);
            } else if (agendaItem._store === 'msg' && context?.chat) {
                const msg = context.chat[agendaItem._msgIndex];
                if (msg?.horae_meta?.agenda) {
                    const found = msg.horae_meta.agenda.find(a => a.text === agendaItem.text);
                    if (found) {
                        found.text = text;
                        found.date = date;
                    }
                    getContext().saveChat();
                }
            }
        } else {
            // Thêm mới
            const agenda = getUserAgenda();
            agenda.push({ text, date, source: 'user', done: false, createdAt: Date.now() });
            setUserAgenda(agenda);
        }
        
        closeEditModal();
        updateAgendaDisplay();
        showToast(isEdit ? 'Đã cập nhật việc cần làm' : 'Đã thêm việc cần làm', 'success');
    });
    
    document.getElementById('agenda-modal-cancel').addEventListener('click', (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        closeEditModal();
    });
    
    // Nút xóa (chỉ có ở chế độ sửa)
    const deleteEl = document.getElementById('agenda-modal-delete');
    if (deleteEl && isEdit) {
        deleteEl.addEventListener('click', (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
            
            if (!confirm('Bạn có chắc muốn xóa việc cần làm này không? Thao tác này không thể hoàn tác.')) return;
            
            deleteAgendaItem(agendaItem);
            closeEditModal();
            updateAgendaDisplay();
            showToast('Đã xóa việc cần làm', 'info');
        });
    }
}

/**
 * Cập nhật hiển thị trang nhân vật
 */
function updateCharactersDisplay() {
    const state = horaeManager.getLatestState();
    const presentChars = state.scene?.characters_present || [];
    const favoriteNpcs = settings.favoriteNpcs || [];
    
    // Lấy tên nhân vật chính trong thẻ nhân vật (để ghim và tạo kiểu đặc biệt)
    const context = getContext();
    const mainCharName = context?.name2 || '';
    
    // Nhân vật đang có mặt
    const presentEl = document.getElementById('horae-present-characters');
    if (presentEl) {
        if (presentChars.length === 0) {
            presentEl.innerHTML = '<div class="horae-empty-hint">Chưa có ghi chép</div>';
        } else {
            presentEl.innerHTML = presentChars.map(char => {
                const isMainChar = mainCharName && char.includes(mainCharName);
                return `
                    <div class="horae-character-badge ${isMainChar ? 'main-character' : ''}">
                        <i class="fa-solid fa-user"></i>
                        ${char}
                    </div>
                `;
            }).join('');
        }
    }
    
    // Hảo cảm - Hiển thị phân cấp: Nhân vật quan trọng > Nhân vật có mặt > Khác
    const affectionEl = document.getElementById('horae-affection-list');
    const pinnedNpcsAff = settings.pinnedNpcs || [];
    if (affectionEl) {
        const entries = Object.entries(state.affection || {});
        if (entries.length === 0) {
            affectionEl.innerHTML = '<div class="horae-empty-hint">Chưa có ghi chép hảo cảm</div>';
        } else {
            // Xác định xem có phải là nhân vật quan trọng không
            const isMainCharAff = (key) => {
                if (pinnedNpcsAff.includes(key)) return true;
                if (mainCharName && key.includes(mainCharName)) return true;
                return false;
            };
            const mainCharAffection = entries.filter(([key]) => isMainCharAff(key));
            const presentAffection = entries.filter(([key]) => 
                !isMainCharAff(key) && presentChars.some(char => key.includes(char))
            );
            const otherAffection = entries.filter(([key]) => 
                !isMainCharAff(key) && !presentChars.some(char => key.includes(char))
            );
            
            const renderAffection = (arr, isMainChar = false) => arr.map(([key, value]) => {
                const numValue = typeof value === 'number' ? value : parseInt(value) || 0;
                const valueClass = numValue > 0 ? 'positive' : numValue < 0 ? 'negative' : 'neutral';
                const level = horaeManager.getAffectionLevel(numValue);
                const mainClass = isMainChar ? 'main-character' : '';
                return `
                    <div class="horae-affection-item horae-editable-item ${mainClass}" data-char="${key}" data-value="${numValue}">
                        ${isMainChar ? '<i class="fa-solid fa-crown main-char-icon"></i>' : ''}
                        <span class="horae-affection-name">${key}</span>
                        <span class="horae-affection-value ${valueClass}">${numValue > 0 ? '+' : ''}${numValue}</span>
                        <span class="horae-affection-level">${level}</span>
                        <button class="horae-item-edit-btn horae-affection-edit-btn" data-edit-type="affection" data-char="${key}" title="Chỉnh sửa hảo cảm">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                    </div>
                `;
            }).join('');
            
            let html = '';
            // Ghim nhân vật trong thẻ nhân vật
            if (mainCharAffection.length > 0) {
                html += renderAffection(mainCharAffection, true);
            }
            if (presentAffection.length > 0) {
                if (mainCharAffection.length > 0) {
                    html += '<div class="horae-affection-divider"></div>';
                }
                html += renderAffection(presentAffection);
            }
            if (otherAffection.length > 0) {
                if (mainCharAffection.length > 0 || presentAffection.length > 0) {
                    html += '<div class="horae-affection-divider"></div>';
                }
                html += renderAffection(otherAffection);
            }
            affectionEl.innerHTML = html;
        }
    }
    
    // Danh sách NPC - Hiển thị phân cấp: Nhân vật quan trọng > Nhân vật đánh dấu sao > Nhân vật thường
    const npcEl = document.getElementById('horae-npc-list');
    const pinnedNpcs = settings.pinnedNpcs || [];
    if (npcEl) {
        const entries = Object.entries(state.npcs || {});
        if (entries.length === 0) {
            npcEl.innerHTML = '<div class="horae-empty-hint">Chưa có ghi chép nhân vật</div>';
        } else {
            // Xác định xem có phải là nhân vật quan trọng không (Nhân vật chính trong thẻ hoặc người dùng đánh dấu thủ công)
            const isMainChar = (name) => {
                if (pinnedNpcs.includes(name)) return true;
                if (mainCharName && name.includes(mainCharName)) return true;
                return false;
            };
            const mainCharEntries = entries.filter(([name]) => isMainChar(name));
            const favoriteEntries = entries.filter(([name]) => 
                !isMainChar(name) && favoriteNpcs.includes(name)
            );
            const normalEntries = entries.filter(([name]) => 
                !isMainChar(name) && !favoriteNpcs.includes(name)
            );
            
            const renderNpc = (name, info, isFavorite, isMainChar = false) => {
                let descHtml = '';
                if (info.appearance || info.personality || info.relationship) {
                    if (info.appearance) descHtml += `<span class="horae-npc-appearance">${info.appearance}</span>`;
                    if (info.personality) descHtml += `<span class="horae-npc-personality">${info.personality}</span>`;
                    if (info.relationship) descHtml += `<span class="horae-npc-relationship">${info.relationship}</span>`;
                } else if (info.description) {
                    descHtml = `<span class="horae-npc-legacy">${info.description}</span>`;
                } else {
                    descHtml = '<span class="horae-npc-legacy">Không có mô tả</span>';
                }
                
                // Dòng thông tin mở rộng (Tuổi/Chủng tộc/Nghề nghiệp, hiển thị gọn)
                const extraTags = [];
                if (info.race) extraTags.push(info.race);
                if (info.age) {
                    const ageResult = horaeManager.calcCurrentAge(info, state.timestamp?.story_date);
                    if (ageResult.changed) {
                        extraTags.push(`<span class="horae-age-calc" title="Gốc:${ageResult.original} (Đã tính thời gian trôi qua)">${ageResult.display} tuổi</span>`);
                    } else {
                        extraTags.push(info.age);
                    }
                }
                if (info.job) extraTags.push(info.job);
                if (extraTags.length > 0) {
                    descHtml += `<span class="horae-npc-extras">${extraTags.join(' · ')}</span>`;
                }
                if (info.note) {
                    descHtml += `<span class="horae-npc-note">${info.note}</span>`;
                }
                
                const starClass = isFavorite ? 'favorite' : '';
                const mainClass = isMainChar ? 'main-character' : '';
                const starIcon = isFavorite ? 'fa-solid fa-star' : 'fa-regular fa-star';
                
                // Ánh xạ biểu tượng giới tính
                let genderIcon, genderClass;
                if (isMainChar) {
                    genderIcon = 'fa-solid fa-crown';
                    genderClass = 'horae-gender-main';
                } else {
                    const g = (info.gender || '').toLowerCase();
                    if (/^(nam|male|m|đực|trống|♂)$/.test(g)) {
                        genderIcon = 'fa-solid fa-person';
                        genderClass = 'horae-gender-male';
                    } else if (/^(nữ|female|f|cái|mái|♀)$/.test(g)) {
                        genderIcon = 'fa-solid fa-person-dress';
                        genderClass = 'horae-gender-female';
                    } else {
                        genderIcon = 'fa-solid fa-user';
                        genderClass = 'horae-gender-unknown';
                    }
                }
                
                return `
                    <div class="horae-npc-item horae-editable-item ${starClass} ${mainClass}" data-npc-name="${name}" data-npc-gender="${info.gender || ''}">
                        <div class="horae-npc-header">
                            <div class="horae-npc-name"><i class="${genderIcon} ${genderClass}"></i> ${name}</div>
                            <div class="horae-npc-actions">
                                <button class="horae-item-edit-btn" data-edit-type="npc" data-edit-name="${name}" title="Chỉnh sửa" style="opacity:1;position:static;">
                                    <i class="fa-solid fa-pen"></i>
                                </button>
                                <button class="horae-npc-star" title="${isFavorite ? 'Bỏ đánh dấu sao' : 'Đánh dấu sao'}">
                                    <i class="${starIcon}"></i>
                                </button>
                            </div>
                        </div>
                        <div class="horae-npc-details">${descHtml}</div>
                    </div>
                `;
            };
            
            // Thanh lọc giới tính
            let html = `
                <div class="horae-gender-filter">
                    <button class="horae-gender-btn active" data-filter="all" title="Tất cả">Tất cả</button>
                    <button class="horae-gender-btn" data-filter="male" title="Nam"><i class="fa-solid fa-person"></i></button>
                    <button class="horae-gender-btn" data-filter="female" title="Nữ"><i class="fa-solid fa-person-dress"></i></button>
                    <button class="horae-gender-btn" data-filter="other" title="Khác/Chưa rõ"><i class="fa-solid fa-user"></i></button>
                </div>
            `;
            
            // Khu vực nhân vật trong thẻ (Ghim)
            if (mainCharEntries.length > 0) {
                html += '<div class="horae-npc-section main-character-section">';
                html += '<div class="horae-npc-section-title"><i class="fa-solid fa-crown"></i> Nhân vật chính</div>';
                html += mainCharEntries.map(([name, info]) => renderNpc(name, info, false, true)).join('');
                html += '</div>';
            }
            
            // Khu vực NPC đánh dấu sao
            if (favoriteEntries.length > 0) {
                if (mainCharEntries.length > 0) {
                    html += '<div class="horae-npc-section-divider"></div>';
                }
                html += '<div class="horae-npc-section favorite-section">';
                html += '<div class="horae-npc-section-title"><i class="fa-solid fa-star"></i> NPC Đánh dấu</div>';
                html += favoriteEntries.map(([name, info]) => renderNpc(name, info, true)).join('');
                html += '</div>';
            }
            
            // Khu vực NPC thường
            if (normalEntries.length > 0) {
                if (mainCharEntries.length > 0 || favoriteEntries.length > 0) {
                    html += '<div class="horae-npc-section-divider"></div>';
                }
                html += '<div class="horae-npc-section">';
                if (mainCharEntries.length > 0 || favoriteEntries.length > 0) {
                    html += '<div class="horae-npc-section-title">NPC Khác</div>';
                }
                html += normalEntries.map(([name, info]) => renderNpc(name, info, false)).join('');
                html += '</div>';
            }
            
            npcEl.innerHTML = html;
            
            npcEl.querySelectorAll('.horae-npc-star').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const npcItem = btn.closest('.horae-npc-item');
                    const npcName = npcItem.dataset.npcName;
                    toggleNpcFavorite(npcName);
                });
            });
            
            bindEditButtons();
            
            npcEl.querySelectorAll('.horae-gender-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    npcEl.querySelectorAll('.horae-gender-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    const filter = btn.dataset.filter;
                    npcEl.querySelectorAll('.horae-npc-item').forEach(item => {
                        if (filter === 'all') {
                            item.style.display = '';
                        } else {
                            const g = (item.dataset.npcGender || '').toLowerCase();
                            let match = false;
                            if (filter === 'male') match = /^(nam|male|m|đực|trống)$/.test(g);
                            else if (filter === 'female') match = /^(nữ|female|f|cái|mái)$/.test(g);
                            else if (filter === 'other') match = !(/^(nam|male|m|đực|trống)$/.test(g) || /^(nữ|female|f|cái|mái)$/.test(g));
                            item.style.display = match ? '' : 'none';
                        }
                    });
                });
            });
        }
    }
}

/**
 * Chuyển đổi trạng thái đánh dấu sao NPC
 */
function toggleNpcFavorite(npcName) {
    if (!settings.favoriteNpcs) {
        settings.favoriteNpcs = [];
    }
    
    const index = settings.favoriteNpcs.indexOf(npcName);
    if (index > -1) {
        // Hủy đánh dấu sao
        settings.favoriteNpcs.splice(index, 1);
        showToast(`Đã hủy đánh dấu sao ${npcName}`, 'info');
    } else {
        // Thêm đánh dấu sao
        settings.favoriteNpcs.push(npcName);
        showToast(`Đã thêm ${npcName} vào đánh dấu sao`, 'success');
    }
    
    saveSettings();
    updateCharactersDisplay();
}

/**
 * Cập nhật hiển thị trang vật phẩm
 */
function updateItemsDisplay() {
    const state = horaeManager.getLatestState();
    const listEl = document.getElementById('horae-items-full-list');
    const filterEl = document.getElementById('horae-items-filter');
    const holderFilterEl = document.getElementById('horae-items-holder-filter');
    const searchEl = document.getElementById('horae-items-search');
    
    if (!listEl) return;
    
    const filterValue = filterEl?.value || 'all';
    const holderFilter = holderFilterEl?.value || 'all';
    const searchQuery = (searchEl?.value || '').trim().toLowerCase();
    let entries = Object.entries(state.items || {});
    
    if (holderFilterEl) {
        const currentHolder = holderFilterEl.value;
        const holders = new Set();
        entries.forEach(([name, info]) => {
            if (info.holder) holders.add(info.holder);
        });
        
        // Giữ lại tùy chọn hiện tại, cập nhật danh sách tùy chọn
        const holderOptions = ['<option value="all">Tất cả</option>'];
        holders.forEach(holder => {
            holderOptions.push(`<option value="${holder}" ${holder === currentHolder ? 'selected' : ''}>${holder}</option>`);
        });
        holderFilterEl.innerHTML = holderOptions.join('');
    }
    
    // Tìm kiếm vật phẩm - Theo từ khóa
    if (searchQuery) {
        entries = entries.filter(([name, info]) => {
            const searchTarget = `${name} ${info.icon || ''} ${info.description || ''} ${info.holder || ''} ${info.location || ''}`.toLowerCase();
            return searchTarget.includes(searchQuery);
        });
    }
    
    // Lọc vật phẩm - Theo mức độ quan trọng
    if (filterValue !== 'all') {
        entries = entries.filter(([name, info]) => info.importance === filterValue);
    }
    
    // Lọc vật phẩm - Theo người sở hữu
    if (holderFilter !== 'all') {
        entries = entries.filter(([name, info]) => info.holder === holderFilter);
    }
    
    if (entries.length === 0) {
        let emptyMsg = 'Chưa có vật phẩm theo dõi';
        if (filterValue !== 'all' || holderFilter !== 'all' || searchQuery) {
            emptyMsg = 'Không có vật phẩm phù hợp với điều kiện lọc';
        }
        listEl.innerHTML = `
            <div class="horae-empty-state">
                <i class="fa-solid fa-box-open"></i>
                <span>${emptyMsg}</span>
            </div>
        `;
        return;
    }
    
    listEl.innerHTML = entries.map(([name, info]) => {
        const icon = info.icon || '📦';
        const importance = info.importance || '';
        // Hỗ trợ 2 định dạng: ""/"!"/"!!" và "Bình thường"/"Quan trọng"/"Then chốt"
        const isCritical = importance === '!!' || importance === '关键';
        const isImportant = importance === '!' || importance === '重要';
        const importanceClass = isCritical ? 'critical' : isImportant ? 'important' : 'normal';
        // Hiển thị nhãn tiếng Việt
        const importanceLabel = isCritical ? 'Then chốt' : isImportant ? 'Quan trọng' : '';
        const importanceBadge = importanceLabel ? `<span class="horae-item-importance ${importanceClass}">${importanceLabel}</span>` : '';
        
        // Sửa định dạng hiển thị: Người sở hữu · Vị trí
        let positionStr = '';
        if (info.holder && info.location) {
            positionStr = `<span class="holder">${info.holder}</span> · ${info.location}`;
        } else if (info.holder) {
            positionStr = `<span class="holder">${info.holder}</span> sở hữu`;
        } else if (info.location) {
            positionStr = `tại ${info.location}`;
        } else {
            positionStr = 'Vị trí chưa rõ';
        }
        
        const isSelected = selectedItems.has(name);
        const selectedClass = isSelected ? 'selected' : '';
        const checkboxDisplay = itemsMultiSelectMode ? 'flex' : 'none';
        const description = info.description || '';
        const descHtml = description ? `<div class="horae-full-item-desc">${description}</div>` : '';
        
        return `
            <div class="horae-full-item horae-editable-item ${importanceClass} ${selectedClass}" data-item-name="${name}">
                <div class="horae-item-checkbox" style="display: ${checkboxDisplay}">
                    <input type="checkbox" ${isSelected ? 'checked' : ''}>
                </div>
                <div class="horae-full-item-icon horae-item-emoji">
                    ${icon}
                </div>
                <div class="horae-full-item-info">
                    <div class="horae-full-item-name">${name} ${importanceBadge}</div>
                    <div class="horae-full-item-location">${positionStr}</div>
                    ${descHtml}
                </div>
                <button class="horae-item-edit-btn" data-edit-type="item" data-edit-name="${name}" title="Chỉnh sửa">
                    <i class="fa-solid fa-pen"></i>
                </button>
            </div>
        `;
    }).join('');
    
    bindItemsEvents();
    bindEditButtons();
}

/**
 * Gắn sự kiện cho nút chỉnh sửa
 */
function bindEditButtons() {
    document.querySelectorAll('.horae-item-edit-btn').forEach(btn => {
        // Xóa listener cũ (tránh gắn trùng)
        btn.replaceWith(btn.cloneNode(true));
    });
    
    document.querySelectorAll('.horae-item-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const editType = btn.dataset.editType;
            const editName = btn.dataset.editName;
            const messageId = btn.dataset.messageId;
            
            if (editType === 'item') {
                openItemEditModal(editName);
            } else if (editType === 'npc') {
                openNpcEditModal(editName);
            } else if (editType === 'event') {
                const eventIndex = parseInt(btn.dataset.eventIndex) || 0;
                openEventEditModal(parseInt(messageId), eventIndex);
            } else if (editType === 'affection') {
                const charName = btn.dataset.char;
                openAffectionEditModal(charName);
            }
        });
    });
}

/**
 * Mở popup chỉnh sửa vật phẩm
 */
function openItemEditModal(itemName) {
    const state = horaeManager.getLatestState();
    const item = state.items?.[itemName];
    if (!item) {
        showToast('Không tìm thấy vật phẩm này', 'error');
        return;
    }
    
    const modalHtml = `
        <div id="horae-edit-modal" class="horae-modal">
            <div class="horae-modal-content">
                <div class="horae-modal-header">
                    <i class="fa-solid fa-pen"></i> Sửa vật phẩm
                </div>
                <div class="horae-modal-body horae-edit-modal-body">
                    <div class="horae-edit-field">
                        <label>Tên vật phẩm</label>
                        <input type="text" id="edit-item-name" value="${itemName}" placeholder="Tên vật phẩm">
                    </div>
                    <div class="horae-edit-field">
                        <label>Biểu tượng (emoji)</label>
                        <input type="text" id="edit-item-icon" value="${item.icon || ''}" maxlength="2" placeholder="📦">
                    </div>
                    <div class="horae-edit-field">
                        <label>Mức độ quan trọng</label>
                        <select id="edit-item-importance">
                            <option value="" ${!item.importance || item.importance === '一般' || item.importance === '' ? 'selected' : ''}>Bình thường</option>
                            <option value="!" ${item.importance === '!' || item.importance === '重要' ? 'selected' : ''}>Quan trọng !</option>
                            <option value="!!" ${item.importance === '!!' || item.importance === '关键' ? 'selected' : ''}>Then chốt !!</option>
                        </select>
                    </div>
                    <div class="horae-edit-field">
                        <label>Mô tả (Chức năng đặc biệt/Nguồn gốc v.v)</label>
                        <textarea id="edit-item-desc" placeholder="Ví dụ: Alice tặng trong buổi hẹn hò">${item.description || ''}</textarea>
                    </div>
                    <div class="horae-edit-field">
                        <label>Người sở hữu</label>
                        <input type="text" id="edit-item-holder" value="${item.holder || ''}" placeholder="Tên nhân vật">
                    </div>
                    <div class="horae-edit-field">
                        <label>Vị trí</label>
                        <input type="text" id="edit-item-location" value="${item.location || ''}" placeholder="Ví dụ: Ba lô, túi, trên bàn trà...">
                    </div>
                </div>
                <div class="horae-modal-footer">
                    <button id="edit-modal-save" class="menu_button primary">
                        <i class="fa-solid fa-check"></i> Lưu
                    </button>
                    <button id="edit-modal-cancel" class="menu_button">
                        <i class="fa-solid fa-xmark"></i> Hủy
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    preventModalBubble();
    
    document.getElementById('edit-modal-save').addEventListener('click', async (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        const newName = document.getElementById('edit-item-name').value.trim();
        if (!newName) {
            showToast('Tên vật phẩm không được để trống', 'error');
            return;
        }
        
        const newData = {
            icon: document.getElementById('edit-item-icon').value || item.icon,
            importance: document.getElementById('edit-item-importance').value,
            description: document.getElementById('edit-item-desc').value,
            holder: document.getElementById('edit-item-holder').value,
            location: document.getElementById('edit-item-location').value
        };
        
        // Cập nhật vật phẩm này trong tất cả tin nhắn
        const chat = horaeManager.getChat();
        const nameChanged = newName !== itemName;
        
        for (let i = 0; i < chat.length; i++) {
            const meta = chat[i].horae_meta;
            if (meta?.items?.[itemName]) {
                if (nameChanged) {
                    // Tên thay đổi: xóa tên cũ, tạo tên mới
                    meta.items[newName] = { ...meta.items[itemName], ...newData };
                    delete meta.items[itemName];
                } else {
                    // Tên không đổi: cập nhật trực tiếp
                    Object.assign(meta.items[itemName], newData);
                }
            }
        }
        
        await getContext().saveChat();
        closeEditModal();
        updateItemsDisplay();
        updateStatusDisplay();
        showToast(nameChanged ? 'Đã đổi tên và cập nhật vật phẩm' : 'Đã cập nhật vật phẩm', 'success');
    });
    
    document.getElementById('edit-modal-cancel').addEventListener('click', (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        closeEditModal();
    });
}

/**
 * Mở popup chỉnh sửa hảo cảm
 */
function openAffectionEditModal(charName) {
    const state = horaeManager.getLatestState();
    const currentValue = state.affection?.[charName] || 0;
    const numValue = typeof currentValue === 'number' ? currentValue : parseInt(currentValue) || 0;
    const level = horaeManager.getAffectionLevel(numValue);
    
    const modalHtml = `
        <div id="horae-edit-modal" class="horae-modal">
            <div class="horae-modal-content">
                <div class="horae-modal-header">
                    <i class="fa-solid fa-heart"></i> Sửa hảo cảm: ${charName}
                </div>
                <div class="horae-modal-body horae-edit-modal-body">
                    <div class="horae-edit-field">
                        <label>Độ hảo cảm hiện tại</label>
                        <input type="number" id="edit-affection-value" value="${numValue}" placeholder="0-100">
                    </div>
                    <div class="horae-edit-field">
                        <label>Cấp độ hảo cảm</label>
                        <span class="horae-affection-level-preview">${level}</span>
                    </div>
                </div>
                <div class="horae-modal-footer">
                    <button id="edit-modal-save" class="menu_button primary">
                        <i class="fa-solid fa-check"></i> Lưu
                    </button>
                    <button id="edit-modal-cancel" class="menu_button">
                        <i class="fa-solid fa-xmark"></i> Hủy
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    preventModalBubble();
    
    // Cập nhật xem trước cấp độ hảo cảm theo thời gian thực
    document.getElementById('edit-affection-value').addEventListener('input', (e) => {
        const val = parseInt(e.target.value) || 0;
        const newLevel = horaeManager.getAffectionLevel(val);
        document.querySelector('.horae-affection-level-preview').textContent = newLevel;
    });
    
    document.getElementById('edit-modal-save').addEventListener('click', (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        const newValue = parseInt(document.getElementById('edit-affection-value').value) || 0;
        
        // Cập nhật hảo cảm trong tất cả tin nhắn (đặt thành giá trị tuyệt đối)
        const chat = horaeManager.getChat();
        let lastMessageWithAffection = -1;
        
        // Tìm tin nhắn cuối cùng có hảo cảm của nhân vật này
        for (let i = chat.length - 1; i >= 0; i--) {
            const meta = chat[i].horae_meta;
            if (meta?.affection?.[charName] !== undefined) {
                lastMessageWithAffection = i;
                break;
            }
        }
        
        if (lastMessageWithAffection >= 0) {
            // Cập nhật hảo cảm của tin nhắn cuối cùng thành giá trị tuyệt đối
            chat[lastMessageWithAffection].horae_meta.affection[charName] = { 
                type: 'absolute', 
                value: newValue 
            };
        } else {
            // Nếu không tìm thấy, thêm vào tin nhắn cuối cùng
            const lastMeta = chat[chat.length - 1]?.horae_meta;
            if (lastMeta) {
                if (!lastMeta.affection) lastMeta.affection = {};
                lastMeta.affection[charName] = { type: 'absolute', value: newValue };
            }
        }
        
        getContext().saveChat();
        closeEditModal();
        updateCharactersDisplay();
        showToast('Đã cập nhật hảo cảm', 'success');
    });
    
    document.getElementById('edit-modal-cancel').addEventListener('click', (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        closeEditModal();
    });
}

/**
 * Mở popup chỉnh sửa NPC
 */
function openNpcEditModal(npcName) {
    const state = horaeManager.getLatestState();
    const npc = state.npcs?.[npcName];
    if (!npc) {
        showToast('Không tìm thấy nhân vật này', 'error');
        return;
    }
    
    const isPinned = (settings.pinnedNpcs || []).includes(npcName);
    
    // Tùy chọn giới tính
    const genderVal = npc.gender || '';
    const genderOptions = [
        { val: '', label: 'Không rõ' },
        { val: 'Nam', label: 'Nam' },
        { val: 'Nữ', label: 'Nữ' },
        { val: 'Khác', label: 'Khác' }
    ].map(o => `<option value="${o.val}" ${genderVal === o.val ? 'selected' : ''}>${o.label}</option>`).join('');
    
    const modalHtml = `
        <div id="horae-edit-modal" class="horae-modal">
            <div class="horae-modal-content">
                <div class="horae-modal-header">
                    <i class="fa-solid fa-pen"></i> Sửa nhân vật: ${npcName}
                </div>
                <div class="horae-modal-body horae-edit-modal-body">
                    <div class="horae-edit-field">
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                            <input type="checkbox" id="edit-npc-pinned" ${isPinned ? 'checked' : ''}>
                            <i class="fa-solid fa-crown" style="color:${isPinned ? '#b388ff' : '#666'}"></i>
                            Đánh dấu là nhân vật quan trọng (Ghim + Viền đặc biệt)
                        </label>
                    </div>
                    <div class="horae-edit-field-row">
                        <div class="horae-edit-field horae-edit-field-compact">
                            <label>Giới tính</label>
                            <select id="edit-npc-gender">${genderOptions}</select>
                        </div>
                        <div class="horae-edit-field horae-edit-field-compact">
                            <label>Tuổi${(() => {
                                const ar = horaeManager.calcCurrentAge(npc, state.timestamp?.story_date);
                                return ar.changed ? ` <span style="font-weight:normal;color:var(--horae-accent)">(Hiện tại:${ar.display})</span>` : '';
                            })()}</label>
                            <input type="text" id="edit-npc-age" value="${npc.age || ''}" placeholder="Ví dụ: 25, khoảng 35">
                        </div>
                        <div class="horae-edit-field horae-edit-field-compact">
                            <label>Chủng tộc</label>
                            <input type="text" id="edit-npc-race" value="${npc.race || ''}" placeholder="Ví dụ: Nhân loại, Elf">
                        </div>
                        <div class="horae-edit-field horae-edit-field-compact">
                            <label>Nghề nghiệp</label>
                            <input type="text" id="edit-npc-job" value="${npc.job || ''}" placeholder="Ví dụ: Lính đánh thuê, Học sinh">
                        </div>
                    </div>
                    <div class="horae-edit-field">
                        <label>Đặc điểm ngoại hình</label>
                        <textarea id="edit-npc-appearance" placeholder="Ví dụ: Cô gái trẻ tóc vàng mắt xanh">${npc.appearance || ''}</textarea>
                    </div>
                    <div class="horae-edit-field">
                        <label>Tính cách</label>
                        <input type="text" id="edit-npc-personality" value="${npc.personality || ''}" placeholder="Ví dụ: Vui vẻ hoạt bát">
                    </div>
                    <div class="horae-edit-field">
                        <label>Mối quan hệ</label>
                        <input type="text" id="edit-npc-relationship" value="${npc.relationship || ''}" placeholder="Ví dụ: Hàng xóm của nhân vật chính">
                    </div>
                    <div class="horae-edit-field">
                        <label>Bổ sung</label>
                        <input type="text" id="edit-npc-note" value="${npc.note || ''}" placeholder="Thông tin quan trọng khác (Tùy chọn)">
                    </div>
                </div>
                <div class="horae-modal-footer">
                    <button id="edit-modal-delete" class="menu_button danger" style="background:#c62828;color:#fff;margin-right:auto;">
                        <i class="fa-solid fa-trash"></i> Xóa nhân vật
                    </button>
                    <button id="edit-modal-save" class="menu_button primary">
                        <i class="fa-solid fa-check"></i> Lưu
                    </button>
                    <button id="edit-modal-cancel" class="menu_button">
                        <i class="fa-solid fa-xmark"></i> Hủy
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    preventModalBubble();
    
    // Xóa NPC
    document.getElementById('edit-modal-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (!confirm(`Bạn có chắc muốn xóa nhân vật「${npcName}」không？\n\nThao tác này sẽ xóa thông tin nhân vật này khỏi tất cả lịch sử trò chuyện và không thể khôi phục.`)) return;
        
        const chat = horaeManager.getChat();
        for (let i = 0; i < chat.length; i++) {
            const meta = chat[i].horae_meta;
            if (meta?.npcs?.[npcName]) {
                delete meta.npcs[npcName];
            }
            // Đồng thời xóa các bản ghi liên quan trong hảo cảm
            if (meta?.affection?.[npcName]) {
                delete meta.affection[npcName];
            }
        }
        
        // Xóa khỏi danh sách ghim
        if (settings.pinnedNpcs) {
            const pinIdx = settings.pinnedNpcs.indexOf(npcName);
            if (pinIdx !== -1) {
                settings.pinnedNpcs.splice(pinIdx, 1);
                saveSettings();
            }
        }
        
        await getContext().saveChat();
        closeEditModal();
        refreshAllDisplays();
        showToast(`Đã xóa nhân vật「${npcName}」`, 'success');
    });
    
    // Lưu chỉnh sửa NPC
    document.getElementById('edit-modal-save').addEventListener('click', async (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        const chat = horaeManager.getChat();
        const newAge = document.getElementById('edit-npc-age').value;
        const newData = {
            appearance: document.getElementById('edit-npc-appearance').value,
            personality: document.getElementById('edit-npc-personality').value,
            relationship: document.getElementById('edit-npc-relationship').value,
            gender: document.getElementById('edit-npc-gender').value,
            age: newAge,
            race: document.getElementById('edit-npc-race').value,
            job: document.getElementById('edit-npc-job').value,
            note: document.getElementById('edit-npc-note').value
        };
        
        // Nếu người dùng sửa tuổi thủ công, cập nhật ngày tham chiếu
        const currentState = horaeManager.getLatestState();
        const ageChanged = newAge !== (npc.age || '');
        if (ageChanged && newAge) {
            newData._ageRefDate = currentState.timestamp?.story_date || '';
        }
        
        // Xử lý đánh dấu nhân vật quan trọng
        const newPinned = document.getElementById('edit-npc-pinned').checked;
        if (!settings.pinnedNpcs) settings.pinnedNpcs = [];
        const pinIdx = settings.pinnedNpcs.indexOf(npcName);
        if (newPinned && pinIdx === -1) {
            settings.pinnedNpcs.push(npcName);
        } else if (!newPinned && pinIdx !== -1) {
            settings.pinnedNpcs.splice(pinIdx, 1);
        }
        saveSettings();
        
        for (let i = 0; i < chat.length; i++) {
            const meta = chat[i].horae_meta;
            if (meta?.npcs?.[npcName]) {
                Object.assign(meta.npcs[npcName], newData);
            }
        }
        
        await getContext().saveChat();
        closeEditModal();
        updateCharactersDisplay();
        showToast('Đã cập nhật nhân vật', 'success');
    });
    
    document.getElementById('edit-modal-cancel').addEventListener('click', (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        closeEditModal();
    });
}

/** Mở popup chỉnh sửa sự kiện */
function openEventEditModal(messageId, eventIndex = 0) {
    const meta = horaeManager.getMessageMeta(messageId);
    if (!meta) {
        showToast('Không tìm thấy siêu dữ liệu của tin nhắn này', 'error');
        return;
    }
    
    // Tương thích định dạng sự kiện cũ và mới
    const eventsArr = meta.events || (meta.event ? [meta.event] : []);
    const event = eventsArr[eventIndex] || {};
    const totalEvents = eventsArr.length;
    
    const modalHtml = `
        <div id="horae-edit-modal" class="horae-modal">
            <div class="horae-modal-content">
                <div class="horae-modal-header">
                    <i class="fa-solid fa-pen"></i> Sửa sự kiện #${messageId}${totalEvents > 1 ? ` (${eventIndex + 1}/${totalEvents})` : ''}
                </div>
                <div class="horae-modal-body horae-edit-modal-body">
                    <div class="horae-edit-field">
                        <label>Cấp độ sự kiện</label>
                        <select id="edit-event-level">
                            <option value="一般" ${event.level === '一般' || !event.level ? 'selected' : ''}>Bình thường</option>
                            <option value="重要" ${event.level === '重要' ? 'selected' : ''}>Quan trọng</option>
                            <option value="关键" ${event.level === '关键' ? 'selected' : ''}>Then chốt</option>
                        </select>
                    </div>
                    <div class="horae-edit-field">
                        <label>Tóm tắt sự kiện</label>
                        <textarea id="edit-event-summary" placeholder="Mô tả sự kiện này...">${event.summary || ''}</textarea>
                    </div>
                </div>
                <div class="horae-modal-footer">
                    <button id="edit-modal-delete" class="menu_button danger">
                        <i class="fa-solid fa-trash"></i> Xóa
                    </button>
                    <button id="edit-modal-save" class="menu_button primary">
                        <i class="fa-solid fa-check"></i> Lưu
                    </button>
                    <button id="edit-modal-cancel" class="menu_button">
                        <i class="fa-solid fa-xmark"></i> Hủy
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    preventModalBubble();
    
    document.getElementById('edit-modal-save').addEventListener('click', async (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        const chat = horaeManager.getChat();
        const chatMeta = chat[messageId]?.horae_meta;
        if (chatMeta) {
            const newLevel = document.getElementById('edit-event-level').value;
            const newSummary = document.getElementById('edit-event-summary').value.trim();
            
            // Cảnh báo: Tóm tắt trống tương đương với xóa
            if (!newSummary) {
                if (!confirm('Tóm tắt sự kiện đang để trống!\n\nSau khi lưu sự kiện này sẽ bị xóa.\n\nBạn có chắc muốn xóa sự kiện này không?')) {
                    return;
                }
                // Người dùng xác nhận xóa, thực hiện logic xóa
                if (!chatMeta.events) {
                    chatMeta.events = chatMeta.event ? [chatMeta.event] : [];
                }
                if (chatMeta.events.length > eventIndex) {
                    chatMeta.events.splice(eventIndex, 1);
                }
                delete chatMeta.event;
                
                await getContext().saveChat();
                closeEditModal();
                updateTimelineDisplay();
                showToast('Đã xóa sự kiện', 'success');
                return;
            }
            
            // Đảm bảo mảng events tồn tại
            if (!chatMeta.events) {
                chatMeta.events = chatMeta.event ? [chatMeta.event] : [];
            }
            
            // Cập nhật hoặc thêm sự kiện
            if (chatMeta.events[eventIndex]) {
                chatMeta.events[eventIndex] = {
                    is_important: newLevel === '重要' || newLevel === '关键',
                    level: newLevel,
                    summary: newSummary
                };
            } else {
                chatMeta.events.push({
                    is_important: newLevel === '重要' || newLevel === '关键',
                    level: newLevel,
                    summary: newSummary
                });
            }
            
            // Xóa định dạng cũ
            delete chatMeta.event;
        }
        
        await getContext().saveChat();
        closeEditModal();
        updateTimelineDisplay();
        showToast('Đã cập nhật sự kiện', 'success');
    });
    
    // Xóa sự kiện (có xác nhận)
    document.getElementById('edit-modal-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (confirm('Bạn có chắc muốn xóa sự kiện này không？\n\n⚠️ Thao tác này không thể hoàn tác！')) {
            const chat = horaeManager.getChat();
            const chatMeta = chat[messageId]?.horae_meta;
            if (chatMeta) {
                // Đảm bảo mảng events tồn tại
                if (!chatMeta.events) {
                    chatMeta.events = chatMeta.event ? [chatMeta.event] : [];
                }
                
                // Xóa sự kiện ở chỉ mục chỉ định
                if (chatMeta.events.length > eventIndex) {
                    chatMeta.events.splice(eventIndex, 1);
                }
                
                // Xóa định dạng cũ
                delete chatMeta.event;
                
                getContext().saveChat();
                closeEditModal();
                updateTimelineDisplay();
                showToast('Đã xóa sự kiện', 'success');
            }
        }
    });
    
    document.getElementById('edit-modal-cancel').addEventListener('click', (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        closeEditModal();
    });
}

/**
 * Đóng popup chỉnh sửa
 */
function closeEditModal() {
    const modal = document.getElementById('horae-edit-modal');
    if (modal) modal.remove();
}

/** Ngăn chặn nổi bọt sự kiện popup chỉnh sửa */
function preventModalBubble() {
    // Ngăn chặn nổi bọt sự kiện
    const targets = [
        document.getElementById('horae-edit-modal'),
        ...document.querySelectorAll('.horae-edit-modal-backdrop')
    ].filter(Boolean);
    
    targets.forEach(modal => {
        ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(evType => {
            modal.addEventListener(evType, (e) => {
                e.stopPropagation();
            });
        });
    });
}

// ============================================
// Chức năng Bảng tùy chỉnh phong cách Excel
// ============================================

let activeContextMenu = null;

/**
 * Render danh sách bảng tùy chỉnh
 */
function renderCustomTablesList() {
    const listEl = document.getElementById('horae-custom-tables-list');
    if (!listEl) return;
    
    const tables = getChatTables();
    
    if (tables.length === 0) {
        listEl.innerHTML = `
            <div class="horae-custom-tables-empty">
                <i class="fa-solid fa-table-cells"></i>
                <div>Chưa có bảng tùy chỉnh</div>
                <div style="font-size:11px;opacity:0.7;margin-top:4px;">Nhấn nút bên dưới để thêm (Bảng được lưu theo cuộc trò chuyện hiện tại)</div>
            </div>
        `;
        return;
    }
    
    listEl.innerHTML = tables.map((table, tableIndex) => {
        const rows = table.rows || 2;
        const cols = table.cols || 2;
        const data = table.data || {};
        
        // Tạo HTML bảng
        let tableHtml = '<table class="horae-excel-table">';
        for (let r = 0; r < rows; r++) {
            tableHtml += '<tr>';
            for (let c = 0; c < cols; c++) {
                const cellKey = `${r}-${c}`;
                const cellValue = data[cellKey] || '';
                const isHeader = r === 0 || c === 0;
                const tag = isHeader ? 'th' : 'td';
                // Tính toán động độ rộng ô nhập liệu
                const charLen = [...cellValue].reduce((sum, ch) => sum + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
                const inputSize = Math.max(4, Math.min(charLen + 2, 40));
                tableHtml += `<${tag} data-row="${r}" data-col="${c}">`;
                tableHtml += `<input type="text" value="${escapeHtml(cellValue)}" size="${inputSize}" data-table="${tableIndex}" data-row="${r}" data-col="${c}" placeholder="${isHeader ? 'Tiêu đề' : ''}">`;
                tableHtml += `</${tag}>`;
            }
            tableHtml += '</tr>';
        }
        tableHtml += '</table>';
        
        return `
            <div class="horae-excel-table-container" data-table-index="${tableIndex}">
                <div class="horae-excel-table-header">
                    <div class="horae-excel-table-title">
                        <i class="fa-solid fa-table"></i>
                        <input type="text" value="${escapeHtml(table.name || '')}" placeholder="Tên bảng" data-table-name="${tableIndex}">
                    </div>
                    <div class="horae-excel-table-actions">
                        <button class="export-table-btn" title="Xuất bảng" data-table-index="${tableIndex}">
                            <i class="fa-solid fa-download"></i>
                        </button>
                        <button class="delete-table-btn danger" title="Xóa bảng">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>
                </div>
                <div class="horae-excel-table-wrapper">
                    ${tableHtml}
                </div>
                <div class="horae-table-prompt-row">
                    <input type="text" value="${escapeHtml(table.prompt || '')}" placeholder="Lời nhắc: Hướng dẫn AI cách điền vào bảng này..." data-table-prompt="${tableIndex}">
                </div>
            </div>
        `;
    }).join('');
    
    bindExcelTableEvents();
}

/**
 * Thoát ký tự HTML
 */
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
}

/**
 * Gắn sự kiện bảng Excel
 */
function bindExcelTableEvents() {
    // Sự kiện nhập liệu ô - tự động lưu + điều chỉnh độ rộng động
    document.querySelectorAll('.horae-excel-table input').forEach(input => {
        input.addEventListener('change', (e) => {
            const tableIndex = parseInt(e.target.dataset.table);
            const row = parseInt(e.target.dataset.row);
            const col = parseInt(e.target.dataset.col);
            const value = e.target.value;
            
            const tables = getChatTables();
            if (!tables[tableIndex].data) {
                tables[tableIndex].data = {};
            }
            tables[tableIndex].data[`${row}-${col}`] = value;
            setChatTables(tables);
        });
        input.addEventListener('input', (e) => {
            const val = e.target.value;
            const charLen = [...val].reduce((sum, ch) => sum + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
            e.target.size = Math.max(4, Math.min(charLen + 2, 40));
        });
    });
    
    // Sự kiện nhập tên bảng
    document.querySelectorAll('[data-table-name]').forEach(input => {
        input.addEventListener('change', (e) => {
            const tableIndex = parseInt(e.target.dataset.tableName);
            const tables = getChatTables();
            tables[tableIndex].name = e.target.value;
            setChatTables(tables);
        });
    });
    
    // Sự kiện nhập lời nhắc bảng
    document.querySelectorAll('[data-table-prompt]').forEach(input => {
        input.addEventListener('change', (e) => {
            const tableIndex = parseInt(e.target.dataset.tablePrompt);
            const tables = getChatTables();
            tables[tableIndex].prompt = e.target.value;
            setChatTables(tables);
        });
    });
    
    // Nút xuất bảng
    document.querySelectorAll('.export-table-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tableIndex = parseInt(btn.dataset.tableIndex);
            exportTable(tableIndex);
        });
    });
    
    // Nút xóa bảng
    document.querySelectorAll('.delete-table-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const container = btn.closest('.horae-excel-table-container');
            const tableIndex = parseInt(container.dataset.tableIndex);
            deleteCustomTable(tableIndex);
        });
    });
    
    // Nhấn giữ tiêu đề hiển thị menu chuột phải
    document.querySelectorAll('.horae-excel-table th').forEach(th => {
        let pressTimer = null;
        
        const startPress = (e) => {
            pressTimer = setTimeout(() => {
                const tableContainer = th.closest('.horae-excel-table-container');
                const tableIndex = parseInt(tableContainer.dataset.tableIndex);
                const row = parseInt(th.dataset.row);
                const col = parseInt(th.dataset.col);
                showTableContextMenu(e, tableIndex, row, col);
            }, 500);
        };
        
        const cancelPress = () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        };
        
        th.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            startPress(e);
        });
        th.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            startPress(e);
        }, { passive: false });
        th.addEventListener('mouseup', (e) => {
            e.stopPropagation();
            cancelPress();
        });
        th.addEventListener('mouseleave', cancelPress);
        th.addEventListener('touchend', (e) => {
            e.stopPropagation();
            cancelPress();
        });
        th.addEventListener('touchcancel', cancelPress);
        
        // Menu chuột phải
        th.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const tableContainer = th.closest('.horae-excel-table-container');
            const tableIndex = parseInt(tableContainer.dataset.tableIndex);
            const row = parseInt(th.dataset.row);
            const col = parseInt(th.dataset.col);
            showTableContextMenu(e, tableIndex, row, col);
        });
    });
    
}

/** Hiển thị menu chuột phải của bảng */
let contextMenuCloseHandler = null;

function showTableContextMenu(e, tableIndex, row, col) {
    hideContextMenu();
    
    const isRowHeader = col === 0 && row > 0;  // Cột đầu (không phải hàng đầu) = Thao tác hàng
    const isColHeader = row === 0 && col > 0;  // Hàng đầu (không phải cột đầu) = Thao tác cột
    const isCorner = row === 0 && col === 0;   // Góc trái trên
    
    let menuItems = '';
    
    if (isCorner) {
        menuItems = `
            <div class="horae-context-menu-item" data-action="add-row-below"><i class="fa-solid fa-plus"></i> Thêm hàng</div>
            <div class="horae-context-menu-item" data-action="add-col-right"><i class="fa-solid fa-plus"></i> Thêm cột</div>
        `;
    } else if (isColHeader) {
        menuItems = `
            <div class="horae-context-menu-item" data-action="add-col-left"><i class="fa-solid fa-arrow-left"></i> Thêm cột bên trái</div>
            <div class="horae-context-menu-item" data-action="add-col-right"><i class="fa-solid fa-arrow-right"></i> Thêm cột bên phải</div>
            <div class="horae-context-menu-divider"></div>
            <div class="horae-context-menu-item danger" data-action="delete-col"><i class="fa-solid fa-trash-can"></i> Xóa cột này</div>
        `;
    } else if (isRowHeader) {
        menuItems = `
            <div class="horae-context-menu-item" data-action="add-row-above"><i class="fa-solid fa-arrow-up"></i> Thêm hàng phía trên</div>
            <div class="horae-context-menu-item" data-action="add-row-below"><i class="fa-solid fa-arrow-down"></i> Thêm hàng phía dưới</div>
            <div class="horae-context-menu-divider"></div>
            <div class="horae-context-menu-item danger" data-action="delete-row"><i class="fa-solid fa-trash-can"></i> Xóa hàng này</div>
        `;
    } else {
        return;
    }
    
    const menu = document.createElement('div');
    menu.className = 'horae-context-menu';
    menu.innerHTML = menuItems;
    
    // Lấy vị trí
    const x = e.clientX || e.touches?.[0]?.clientX || 100;
    const y = e.clientY || e.touches?.[0]?.clientY || 100;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    
    document.body.appendChild(menu);
    activeContextMenu = menu;
    
    // Đảm bảo menu không vượt quá màn hình
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 10}px`;
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 10}px`;
    }
    
    // Gắn click menu item - thực hiện hành động và đóng menu
    menu.querySelectorAll('.horae-context-menu-item').forEach(item => {
        item.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
            const action = item.dataset.action;
            hideContextMenu();
            setTimeout(() => {
                executeTableAction(tableIndex, row, col, action);
            }, 10);
        });
        
        item.addEventListener('touchend', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
            const action = item.dataset.action;
            hideContextMenu();
            setTimeout(() => {
                executeTableAction(tableIndex, row, col, action);
            }, 10);
        });
    });
    
    ['click', 'touchstart', 'touchend', 'mousedown', 'mouseup'].forEach(eventType => {
        menu.addEventListener(eventType, (ev) => {
            ev.stopPropagation();
            ev.stopImmediatePropagation();
        });
    });
    
    // Gắn trễ để tránh sự kiện hiện tại kích hoạt
    setTimeout(() => {
        contextMenuCloseHandler = (ev) => {
            if (activeContextMenu && !activeContextMenu.contains(ev.target)) {
                hideContextMenu();
            }
        };
        document.addEventListener('click', contextMenuCloseHandler, true);
        document.addEventListener('touchstart', contextMenuCloseHandler, true);
    }, 50);
    
    e.preventDefault();
    e.stopPropagation();
}

/**
 * Ẩn menu chuột phải
 */
function hideContextMenu() {
    if (contextMenuCloseHandler) {
        document.removeEventListener('click', contextMenuCloseHandler, true);
        document.removeEventListener('touchstart', contextMenuCloseHandler, true);
        contextMenuCloseHandler = null;
    }
    
    if (activeContextMenu) {
        activeContextMenu.remove();
        activeContextMenu = null;
    }
}

/**
 * Thực hiện hành động bảng
 */
function executeTableAction(tableIndex, row, col, action) {
    const tables = getChatTables();
    const table = tables[tableIndex];
    if (!table) return;
    
    const oldRows = table.rows || 2;
    const oldCols = table.cols || 2;
    const oldData = table.data || {};
    const newData = {};
    
    switch (action) {
        case 'add-row-above':
            table.rows = oldRows + 1;
            for (const [key, val] of Object.entries(oldData)) {
                const [r, c] = key.split('-').map(Number);
                const newRow = r >= row ? r + 1 : r;
                newData[`${newRow}-${c}`] = val;
            }
            table.data = newData;
            break;
            
        case 'add-row-below':
            table.rows = oldRows + 1;
            for (const [key, val] of Object.entries(oldData)) {
                const [r, c] = key.split('-').map(Number);
                const newRow = r > row ? r + 1 : r;
                newData[`${newRow}-${c}`] = val;
            }
            table.data = newData;
            break;
            
        case 'add-col-left':
            table.cols = oldCols + 1;
            for (const [key, val] of Object.entries(oldData)) {
                const [r, c] = key.split('-').map(Number);
                const newCol = c >= col ? c + 1 : c;
                newData[`${r}-${newCol}`] = val;
            }
            table.data = newData;
            break;
            
        case 'add-col-right':
            table.cols = oldCols + 1;
            for (const [key, val] of Object.entries(oldData)) {
                const [r, c] = key.split('-').map(Number);
                const newCol = c > col ? c + 1 : c;
                newData[`${r}-${newCol}`] = val;
            }
            table.data = newData;
            break;
            
        case 'delete-row':
            if (oldRows <= 2) {
                showToast('Bảng cần ít nhất 2 hàng', 'warning');
                return;
            }
            table.rows = oldRows - 1;
            for (const [key, val] of Object.entries(oldData)) {
                const [r, c] = key.split('-').map(Number);
                if (r === row) continue;
                const newRow = r > row ? r - 1 : r;
                newData[`${newRow}-${c}`] = val;
            }
            table.data = newData;
            break;
            
        case 'delete-col':
            if (oldCols <= 2) {
                showToast('Bảng cần ít nhất 2 cột', 'warning');
                return;
            }
            table.cols = oldCols - 1;
            for (const [key, val] of Object.entries(oldData)) {
                const [r, c] = key.split('-').map(Number);
                if (c === col) continue;
                const newCol = c > col ? c - 1 : c;
                newData[`${r}-${newCol}`] = val;
            }
            table.data = newData;
            break;
    }
    
    setChatTables(tables);
    renderCustomTablesList();
}

/**
 * Thêm bảng 2x2 mới
 */
function addNewExcelTable() {
    const tables = getChatTables();
    
    tables.push({
        id: Date.now().toString(),
        name: '',
        rows: 2,
        cols: 2,
        data: {},
        baseData: {},
        baseRows: 2,
        baseCols: 2,
        prompt: ''
    });
    
    setChatTables(tables);
    renderCustomTablesList();
    showToast('Đã thêm bảng mới', 'success');
}

/**
 * Xóa bảng
 */
function deleteCustomTable(index) {
    if (!confirm('Bạn có chắc muốn xóa bảng này không?')) return;
    
    const tables = getChatTables();
    tables.splice(index, 1);
    setChatTables(tables);
    renderCustomTablesList();
    showToast('Đã xóa bảng', 'info');
}

/**
 * Gắn sự kiện danh sách vật phẩm (nhấn giữ, click)
 */
function bindItemsEvents() {
    const items = document.querySelectorAll('#horae-items-full-list .horae-full-item');
    
    items.forEach(item => {
        const itemName = item.dataset.itemName;
        if (!itemName) return;
        
        // Nhấn giữ để vào chế độ đa chọn
        item.addEventListener('mousedown', (e) => startLongPress(e, itemName));
        item.addEventListener('touchstart', (e) => startLongPress(e, itemName), { passive: true });
        item.addEventListener('mouseup', cancelLongPress);
        item.addEventListener('mouseleave', cancelLongPress);
        item.addEventListener('touchend', cancelLongPress);
        item.addEventListener('touchcancel', cancelLongPress);
        
        // Trong chế độ đa chọn, click để chuyển đổi chọn
        item.addEventListener('click', () => {
            if (itemsMultiSelectMode) {
                toggleItemSelection(itemName);
            }
        });
    });
}

/**
 * Bắt đầu tính giờ nhấn giữ
 */
function startLongPress(e, itemName) {
    if (itemsMultiSelectMode) return; // Đã ở chế độ đa chọn
    
    longPressTimer = setTimeout(() => {
        enterMultiSelectMode(itemName);
    }, 800); // 800ms nhấn giữ kích hoạt (kéo dài tránh chạm nhầm)
}

/**
 * Hủy nhấn giữ
 */
function cancelLongPress() {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
}

/**
 * Vào chế độ đa chọn
 */
function enterMultiSelectMode(initialItem) {
    itemsMultiSelectMode = true;
    selectedItems.clear();
    if (initialItem) {
        selectedItems.add(initialItem);
    }
    
    // Hiển thị thanh công cụ đa chọn
    const bar = document.getElementById('horae-items-multiselect-bar');
    if (bar) bar.style.display = 'flex';
    
    // Ẩn gợi ý
    const hint = document.querySelector('#horae-tab-items .horae-items-hint');
    if (hint) hint.style.display = 'none';
    
    updateItemsDisplay();
    updateSelectedCount();
    
    showToast('Đã vào chế độ đa chọn', 'info');
}

/**
 * Thoát chế độ đa chọn
 */
function exitMultiSelectMode() {
    itemsMultiSelectMode = false;
    selectedItems.clear();
    
    // Ẩn thanh công cụ đa chọn
    const bar = document.getElementById('horae-items-multiselect-bar');
    if (bar) bar.style.display = 'none';
    
    // Hiển thị gợi ý
    const hint = document.querySelector('#horae-tab-items .horae-items-hint');
    if (hint) hint.style.display = 'block';
    
    updateItemsDisplay();
}

/**
 * Chuyển đổi trạng thái chọn vật phẩm
 */
function toggleItemSelection(itemName) {
    if (selectedItems.has(itemName)) {
        selectedItems.delete(itemName);
    } else {
        selectedItems.add(itemName);
    }
    
    // Cập nhật UI
    const item = document.querySelector(`#horae-items-full-list .horae-full-item[data-item-name="${itemName}"]`);
    if (item) {
        const checkbox = item.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = selectedItems.has(itemName);
        item.classList.toggle('selected', selectedItems.has(itemName));
    }
    
    updateSelectedCount();
}

/**
 * Chọn tất cả vật phẩm
 */
function selectAllItems() {
    const items = document.querySelectorAll('#horae-items-full-list .horae-full-item');
    items.forEach(item => {
        const name = item.dataset.itemName;
        if (name) selectedItems.add(name);
    });
    updateItemsDisplay();
    updateSelectedCount();
}

/**
 * Cập nhật hiển thị số lượng đã chọn
 */
function updateSelectedCount() {
    const countEl = document.getElementById('horae-items-selected-count');
    if (countEl) countEl.textContent = selectedItems.size;
}

/**
 * Xóa các vật phẩm đã chọn
 */
async function deleteSelectedItems() {
    if (selectedItems.size === 0) {
        showToast('Chưa chọn vật phẩm nào', 'warning');
        return;
    }
    
    // Hộp thoại xác nhận
    const confirmed = confirm(`Bạn có chắc muốn xóa ${selectedItems.size} vật phẩm đã chọn không？\n\nThao tác này sẽ xóa các vật phẩm này khỏi tất cả lịch sử ghi chép, không thể hoàn tác.`);
    if (!confirmed) return;
    
    // Xóa các vật phẩm này khỏi meta của tất cả tin nhắn
    const chat = horaeManager.getChat();
    const itemsToDelete = Array.from(selectedItems);
    
    for (let i = 0; i < chat.length; i++) {
        const meta = chat[i].horae_meta;
        if (meta && meta.items) {
            for (const itemName of itemsToDelete) {
                if (meta.items[itemName]) {
                    delete meta.items[itemName];
                }
            }
        }
    }
    
    // Lưu thay đổi
    await getContext().saveChat();
    
    showToast(`Đã xóa ${itemsToDelete.length} vật phẩm`, 'success');
    
    exitMultiSelectMode();
    updateStatusDisplay();
}

/**
 * Làm mới tất cả hiển thị
 */
function refreshAllDisplays() {
    updateStatusDisplay();
    updateAgendaDisplay();
    updateTimelineDisplay();
    updateCharactersDisplay();
    updateItemsDisplay();
}

/**
 * Cuộn đến tin nhắn chỉ định
 */
function scrollToMessage(messageId) {
    const messageEl = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (messageEl) {
        messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        messageEl.classList.add('horae-highlight');
        setTimeout(() => messageEl.classList.remove('horae-highlight'), 2000);
    }
}

/**
 * Thêm bảng điều khiển siêu dữ liệu cho tin nhắn
 */
function addMessagePanel(messageEl, messageIndex) {
    const existingPanel = messageEl.querySelector('.horae-message-panel');
    if (existingPanel) return;
    
    const meta = horaeManager.getMessageMeta(messageIndex);
    if (!meta) return;
    
    // Định dạng thời gian (lịch tiêu chuẩn thêm thứ)
    let time = '--';
    if (meta.timestamp?.story_date) {
        const parsed = parseStoryDate(meta.timestamp.story_date);
        if (parsed && parsed.type === 'standard') {
            time = formatStoryDate(parsed, true);
        } else {
            time = meta.timestamp.story_date;
        }
        if (meta.timestamp.story_time) {
            time += ' ' + meta.timestamp.story_time;
        }
    }
    // Tương thích định dạng sự kiện cũ và mới
    const eventsArr = meta.events || (meta.event ? [meta.event] : []);
    const eventSummary = eventsArr.length > 0 
        ? eventsArr.map(e => e.summary).join(' | ') 
        : 'Không có sự kiện đặc biệt';
    const charCount = meta.scene?.characters_present?.length || 0;
    
    const panelHtml = `
        <div class="horae-message-panel" data-message-id="${messageIndex}">
            <div class="horae-panel-toggle">
                <div class="horae-panel-icon">
                    <i class="fa-regular fa-clock"></i>
                </div>
                <div class="horae-panel-summary">
                    <span class="horae-summary-time">${time}</span>
                    <span class="horae-summary-divider">|</span>
                    <span class="horae-summary-event">${eventSummary}</span>
                    <span class="horae-summary-divider">|</span>
                    <span class="horae-summary-chars">${charCount} người có mặt</span>
                </div>
                <div class="horae-panel-actions">
                    <button class="horae-btn-rescan" title="Quét lại tin nhắn này">
                        <i class="fa-solid fa-rotate"></i>
                    </button>
                    <button class="horae-btn-expand" title="Mở rộng/Thu gọn">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                </div>
            </div>
            <div class="horae-panel-content" style="display: none;">
                ${buildPanelContent(messageIndex, meta)}
            </div>
        </div>
    `;
    
    const mesTextEl = messageEl.querySelector('.mes_text');
    if (mesTextEl) {
        mesTextEl.insertAdjacentHTML('afterend', panelHtml);
        const panelEl = messageEl.querySelector('.horae-message-panel');
        bindPanelEvents(panelEl);
        if (!settings.showMessagePanel && panelEl) {
            panelEl.style.display = 'none';
        }
    }
}

/**
 * Xây dựng hiển thị vật phẩm đã xóa
 */
function buildDeletedItemsDisplay(deletedItems) {
    if (!deletedItems || deletedItems.length === 0) {
        return '<div class="horae-empty-hint">Không tiêu hao vật phẩm</div>';
    }
    return deletedItems.map(item => `
        <div class="horae-deleted-item-tag">
            <i class="fa-solid fa-xmark"></i> ${item}
        </div>
    `).join('');
}

/**
 * Xây dựng các hàng chỉnh sửa việc cần làm
 */
function buildAgendaEditorRows(agenda) {
    if (!agenda || agenda.length === 0) {
        return '<div class="horae-empty-hint">Không có việc cần làm</div>';
    }
    return agenda.map(item => `
        <div class="horae-editor-row horae-agenda-edit-row">
            <input type="text" class="agenda-date" style="flex:0 0 90px;max-width:90px;" value="${escapeHtml(item.date || '')}" placeholder="Ngày">
            <input type="text" class="agenda-text" style="flex:1 1 0;min-width:0;" value="${escapeHtml(item.text || '')}" placeholder="Nội dung việc cần làm (thời gian tương đối vui lòng ghi chú ngày tuyệt đối)">
            <button class="delete-btn"><i class="fa-solid fa-xmark"></i></button>
        </div>
    `).join('');
}

/**
 * Xây dựng nội dung chi tiết của bảng điều khiển
 */
function buildPanelContent(messageIndex, meta) {
    const costumeRows = Object.entries(meta.costumes || {}).map(([char, costume]) => `
        <div class="horae-editor-row">
            <input type="text" class="char-input" value="${char}" placeholder="Tên nhân vật">
            <input type="text" value="${costume}" placeholder="Mô tả trang phục">
            <button class="delete-btn"><i class="fa-solid fa-xmark"></i></button>
        </div>
    `).join('') || '<div class="horae-empty-hint">Không thay đổi trang phục</div>';
    
    // Phân loại vật phẩm được quản lý bởi trang chính, thanh dưới cùng không hiển thị
    const itemRows = Object.entries(meta.items || {}).map(([name, info]) => {
        return `
            <div class="horae-editor-row horae-item-row">
                <input type="text" class="item-icon" value="${info.icon || ''}" placeholder="📦" maxlength="2">
                <input type="text" class="item-name" value="${name}" placeholder="Tên vật phẩm">
                <input type="text" class="item-holder" value="${info.holder || ''}" placeholder="Người sở hữu">
                <input type="text" class="item-location" value="${info.location || ''}" placeholder="Vị trí">
                <button class="delete-btn"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="horae-editor-row horae-item-desc-row">
                <input type="text" class="item-description" value="${info.description || ''}" placeholder="Mô tả vật phẩm">
            </div>
        `;
    }).join('') || '<div class="horae-empty-hint">Không thay đổi vật phẩm</div>';
    
    // Lấy tổng giá trị hảo cảm của tin nhắn trước đó
    const prevTotals = {};
    const chat = horaeManager.getChat();
    for (let i = 0; i < messageIndex; i++) {
        const m = chat[i]?.horae_meta;
        if (m?.affection) {
            for (const [k, v] of Object.entries(m.affection)) {
                let val = 0;
                if (typeof v === 'object' && v !== null) {
                    if (v.type === 'absolute') val = parseInt(v.value) || 0;
                    else if (v.type === 'relative') val = (prevTotals[k] || 0) + (parseInt(v.value) || 0);
                } else {
                    val = (prevTotals[k] || 0) + (parseInt(v) || 0);
                }
                prevTotals[k] = val;
            }
        }
    }
    
    const affectionRows = Object.entries(meta.affection || {}).map(([key, value]) => {
        // Phân tích giá trị lớp hiện tại
        let delta = 0, newTotal = 0;
        const prevVal = prevTotals[key] || 0;
        
        if (typeof value === 'object' && value !== null) {
            if (value.type === 'absolute') {
                newTotal = parseInt(value.value) || 0;
                delta = newTotal - prevVal;
            } else if (value.type === 'relative') {
                delta = parseInt(value.value) || 0;
                newTotal = prevVal + delta;
            }
        } else {
            delta = parseInt(value) || 0;
            newTotal = prevVal + delta;
        }
        
        const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
        return `
            <div class="horae-editor-row horae-affection-row" data-char="${key}" data-prev="${prevVal}">
                <span class="affection-char">${key}</span>
                <input type="text" class="affection-delta" value="${deltaStr}" placeholder="±Thay đổi">
                <input type="number" class="affection-total" value="${newTotal}" placeholder="Tổng">
                <button class="delete-btn"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `;
    }).join('') || '<div class="horae-empty-hint">Không thay đổi hảo cảm</div>';
    
    // Tương thích định dạng sự kiện cũ và mới
    const eventsArr = meta.events || (meta.event ? [meta.event] : []);
    const firstEvent = eventsArr[0] || {};
    const eventLevel = firstEvent.level || '';
    const eventSummary = firstEvent.summary || '';
    const multipleEventsNote = eventsArr.length > 1 ? `<span class="horae-note">（Tin nhắn này có ${eventsArr.length} sự kiện, chỉ hiển thị cái đầu tiên）</span>` : '';
    
    return `
        <div class="horae-panel-grid">
            <div class="horae-panel-row">
                <label><i class="fa-regular fa-clock"></i> Thời gian</label>
                <div class="horae-panel-value">
                    <input type="text" class="horae-input-datetime" placeholder="Ngày Giờ (Ví dụ 2026/2/4 15:00)" value="${(() => {
                        let val = meta.timestamp?.story_date || '';
                        if (meta.timestamp?.story_time) val += (val ? ' ' : '') + meta.timestamp.story_time;
                        return val;
                    })()}">
                </div>
            </div>
            <div class="horae-panel-row">
                <label><i class="fa-solid fa-location-dot"></i> Địa điểm</label>
                <div class="horae-panel-value">
                    <input type="text" class="horae-input-location" value="${meta.scene?.location || ''}" placeholder="Vị trí bối cảnh">
                </div>
            </div>
            <div class="horae-panel-row">
                <label><i class="fa-solid fa-cloud"></i> Bầu không khí</label>
                <div class="horae-panel-value">
                    <input type="text" class="horae-input-atmosphere" value="${meta.scene?.atmosphere || ''}" placeholder="Không khí bối cảnh">
                </div>
            </div>
            <div class="horae-panel-row">
                <label><i class="fa-solid fa-users"></i> Có mặt</label>
                <div class="horae-panel-value">
                    <input type="text" class="horae-input-characters" value="${(meta.scene?.characters_present || []).join(', ')}" placeholder="Tên nhân vật, phân cách bằng dấu phẩy">
                </div>
            </div>
            <div class="horae-panel-row full-width">
                <label><i class="fa-solid fa-shirt"></i> Thay đổi trang phục</label>
                <div class="horae-costume-editor">${costumeRows}</div>
                <button class="horae-btn-add-costume"><i class="fa-solid fa-plus"></i> Thêm</button>
            </div>
            <div class="horae-panel-row full-width">
                <label><i class="fa-solid fa-box-open"></i> Nhận/Thay đổi vật phẩm</label>
                <div class="horae-items-editor">${itemRows}</div>
                <button class="horae-btn-add-item"><i class="fa-solid fa-plus"></i> Thêm</button>
            </div>
            <div class="horae-panel-row full-width">
                <label><i class="fa-solid fa-trash-can"></i> Tiêu thụ/Xóa vật phẩm</label>
                <div class="horae-deleted-items-display">${buildDeletedItemsDisplay(meta.deletedItems)}</div>
            </div>
            <div class="horae-panel-row full-width">
                <label><i class="fa-solid fa-bookmark"></i> Sự kiện ${multipleEventsNote}</label>
                <div class="horae-event-editor">
                    <select class="horae-input-event-level">
                        <option value="">Không</option>
                        <option value="一般" ${eventLevel === '一般' ? 'selected' : ''}>Bình thường</option>
                        <option value="重要" ${eventLevel === '重要' ? 'selected' : ''}>Quan trọng</option>
                        <option value="关键" ${eventLevel === '关键' ? 'selected' : ''}>Then chốt</option>
                    </select>
                    <input type="text" class="horae-input-event-summary" value="${eventSummary}" placeholder="Tóm tắt sự kiện">
                </div>
            </div>
            <div class="horae-panel-row full-width">
                <label><i class="fa-solid fa-heart"></i> Hảo cảm</label>
                <div class="horae-affection-editor">${affectionRows}</div>
                <button class="horae-btn-add-affection"><i class="fa-solid fa-plus"></i> Thêm</button>
            </div>
            <div class="horae-panel-row full-width">
                <label><i class="fa-solid fa-list-check"></i> Việc cần làm</label>
                <div class="horae-agenda-editor">${buildAgendaEditorRows(meta.agenda)}</div>
                <button class="horae-btn-add-agenda-row"><i class="fa-solid fa-plus"></i> Thêm</button>
            </div>
        </div>
        <div class="horae-panel-rescan">
            <div class="horae-rescan-label"><i class="fa-solid fa-rotate"></i> Quét lại tin nhắn này</div>
            <div class="horae-rescan-buttons">
                <button class="horae-btn-quick-scan menu_button" title="Trích xuất dữ liệu định dạng từ văn bản hiện có (không tiêu tốn API)">
                    <i class="fa-solid fa-bolt"></i> Phân tích nhanh
                </button>
                <button class="horae-btn-ai-analyze menu_button" title="Sử dụng AI phân tích nội dung tin nhắn (tiêu tốn API)">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> AI Phân tích
                </button>
            </div>
        </div>
        <div class="horae-panel-footer">
            <button class="horae-btn-save menu_button"><i class="fa-solid fa-check"></i> Lưu</button>
            <button class="horae-btn-cancel menu_button"><i class="fa-solid fa-xmark"></i> Hủy</button>
        </div>
    `;
}

/**
 * Gắn sự kiện cho bảng điều khiển
 */
function bindPanelEvents(panelEl) {
    if (!panelEl) return;
    
    const messageId = parseInt(panelEl.dataset.messageId);
    const toggleEl = panelEl.querySelector('.horae-panel-toggle');
    const contentEl = panelEl.querySelector('.horae-panel-content');
    const expandBtn = panelEl.querySelector('.horae-btn-expand');
    
    // Mở rộng/Thu gọn - Nhấn vào toàn bộ thanh ngang hoặc nút mở rộng đều kích hoạt
    const rescanBtn = panelEl.querySelector('.horae-btn-rescan');
    toggleEl?.addEventListener('click', (e) => {
        if (e.target.closest('.horae-btn-expand') || e.target.closest('.horae-btn-rescan')) return;
        togglePanel();
    });
    
    expandBtn?.addEventListener('click', togglePanel);
    
    // Quét lại tin nhắn này
    rescanBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        rescanMessageMeta(messageId, panelEl);
    });
    
    function togglePanel() {
        const isHidden = contentEl.style.display === 'none';
        contentEl.style.display = isHidden ? 'block' : 'none';
        const icon = expandBtn.querySelector('i');
        icon.className = isHidden ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
    }
    
    panelEl.querySelector('.horae-btn-save')?.addEventListener('click', () => {
        savePanelData(panelEl, messageId);
    });
    
    panelEl.querySelector('.horae-btn-cancel')?.addEventListener('click', () => {
        contentEl.style.display = 'none';
    });
    
    panelEl.querySelector('.horae-btn-add-costume')?.addEventListener('click', () => {
        const editor = panelEl.querySelector('.horae-costume-editor');
        const emptyHint = editor.querySelector('.horae-empty-hint');
        if (emptyHint) emptyHint.remove();
        
        editor.insertAdjacentHTML('beforeend', `
            <div class="horae-editor-row">
                <input type="text" class="char-input" placeholder="Tên nhân vật">
                <input type="text" placeholder="Mô tả trang phục">
                <button class="delete-btn"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `);
        bindDeleteButtons(editor);
    });
    
    panelEl.querySelector('.horae-btn-add-item')?.addEventListener('click', () => {
        const editor = panelEl.querySelector('.horae-items-editor');
        const emptyHint = editor.querySelector('.horae-empty-hint');
        if (emptyHint) emptyHint.remove();
        
        editor.insertAdjacentHTML('beforeend', `
            <div class="horae-editor-row horae-item-row">
                <input type="text" class="item-icon" placeholder="📦" maxlength="2">
                <input type="text" class="item-name" placeholder="Tên vật phẩm">
                <input type="text" class="item-holder" placeholder="Người sở hữu">
                <input type="text" class="item-location" placeholder="Vị trí">
                <button class="delete-btn"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="horae-editor-row horae-item-desc-row">
                <input type="text" class="item-description" placeholder="Mô tả vật phẩm">
            </div>
        `);
        bindDeleteButtons(editor);
    });
    
    panelEl.querySelector('.horae-btn-add-affection')?.addEventListener('click', () => {
        const editor = panelEl.querySelector('.horae-affection-editor');
        const emptyHint = editor.querySelector('.horae-empty-hint');
        if (emptyHint) emptyHint.remove();
        
        editor.insertAdjacentHTML('beforeend', `
            <div class="horae-editor-row horae-affection-row" data-char="" data-prev="0">
                <input type="text" class="affection-char-input" placeholder="Tên nhân vật">
                <input type="text" class="affection-delta" value="+0" placeholder="±Thay đổi">
                <input type="number" class="affection-total" value="0" placeholder="Tổng">
                <button class="delete-btn"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `);
        bindDeleteButtons(editor);
        bindAffectionInputs(editor);
    });
    
    // Thêm hàng việc cần làm
    panelEl.querySelector('.horae-btn-add-agenda-row')?.addEventListener('click', () => {
        const editor = panelEl.querySelector('.horae-agenda-editor');
        const emptyHint = editor.querySelector('.horae-empty-hint');
        if (emptyHint) emptyHint.remove();
        
        editor.insertAdjacentHTML('beforeend', `
            <div class="horae-editor-row horae-agenda-edit-row">
                <input type="text" class="agenda-date" style="flex:0 0 90px;max-width:90px;" value="" placeholder="Ngày">
                <input type="text" class="agenda-text" style="flex:1 1 0;min-width:0;" value="" placeholder="Nội dung việc cần làm (thời gian tương đối vui lòng ghi chú ngày tuyệt đối)">
                <button class="delete-btn"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `);
        bindDeleteButtons(editor);
    });
    
    // Liên kết đầu vào hảo cảm
    bindAffectionInputs(panelEl.querySelector('.horae-affection-editor'));
    
    // Liên kết nút xóa hiện có
    bindDeleteButtons(panelEl);
    
    // Nút phân tích nhanh (không tốn API)
    panelEl.querySelector('.horae-btn-quick-scan')?.addEventListener('click', async () => {
        const chat = horaeManager.getChat();
        const message = chat[messageId];
        if (!message) {
            showToast('Không thể lấy nội dung tin nhắn', 'error');
            return;
        }
        
        // Thử phân tích thẻ chuẩn trước
        let parsed = horaeManager.parseHoraeTag(message.mes);
        
        // Nếu không có thẻ, thử phân tích lỏng lẻo
        if (!parsed) {
            parsed = horaeManager.parseLooseFormat(message.mes);
        }
        
        if (parsed) {
            // Lấy meta hiện có và hợp nhất
            const existingMeta = horaeManager.getMessageMeta(messageId) || createEmptyMeta();
            const newMeta = horaeManager.mergeParsedToMeta(existingMeta, parsed);
            // Xử lý cập nhật bảng
            if (newMeta._tableUpdates) {
                horaeManager.applyTableUpdates(newMeta._tableUpdates);
                delete newMeta._tableUpdates;
            }
            // Xử lý việc cần làm đã hoàn thành
            if (parsed.deletedAgenda && parsed.deletedAgenda.length > 0) {
                horaeManager.removeCompletedAgenda(parsed.deletedAgenda);
            }
            horaeManager.setMessageMeta(messageId, newMeta);
            
            const contentEl = panelEl.querySelector('.horae-panel-content');
            if (contentEl) {
                contentEl.innerHTML = buildPanelContent(messageId, newMeta);
                bindPanelEvents(panelEl);
            }
            
            getContext().saveChat();
            refreshAllDisplays();
            showToast('Phân tích nhanh hoàn tất!', 'success');
        } else {
            showToast('Không trích xuất được dữ liệu định dạng từ văn bản, vui lòng thử AI Phân tích', 'warning');
        }
    });
    
    // Nút AI Phân tích (tốn API)
    panelEl.querySelector('.horae-btn-ai-analyze')?.addEventListener('click', async () => {
        const chat = horaeManager.getChat();
        const message = chat[messageId];
        if (!message) {
            showToast('Không thể lấy nội dung tin nhắn', 'error');
            return;
        }
        
        const btn = panelEl.querySelector('.horae-btn-ai-analyze');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang phân tích...';
        btn.disabled = true;
        
        try {
            // Gọi AI phân tích
            const result = await analyzeMessageWithAI(message.mes);
            
            if (result) {
                const existingMeta = horaeManager.getMessageMeta(messageId) || createEmptyMeta();
                const newMeta = horaeManager.mergeParsedToMeta(existingMeta, result);
                if (newMeta._tableUpdates) {
                    horaeManager.applyTableUpdates(newMeta._tableUpdates);
                    delete newMeta._tableUpdates;
                }
                // Xử lý việc cần làm đã hoàn thành
                if (result.deletedAgenda && result.deletedAgenda.length > 0) {
                    horaeManager.removeCompletedAgenda(result.deletedAgenda);
                }
                horaeManager.setMessageMeta(messageId, newMeta);
                
                const contentEl = panelEl.querySelector('.horae-panel-content');
                if (contentEl) {
                    contentEl.innerHTML = buildPanelContent(messageId, newMeta);
                    bindPanelEvents(panelEl);
                }
                
                getContext().saveChat();
                refreshAllDisplays();
                showToast('AI Phân tích hoàn tất!', 'success');
            } else {
                showToast('AI Phân tích không trả về dữ liệu hợp lệ', 'warning');
            }
        } catch (error) {
            console.error('[Horae] AI Phân tích thất bại:', error);
            showToast('AI Phân tích thất bại: ' + error.message, 'error');
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });
}

/**
 * Gắn sự kiện nút xóa
 */
function bindDeleteButtons(container) {
    container.querySelectorAll('.delete-btn').forEach(btn => {
        btn.onclick = () => btn.closest('.horae-editor-row')?.remove();
    });
}

/**
 * Liên kết đầu vào hảo cảm
 */
function bindAffectionInputs(container) {
    if (!container) return;
    
    container.querySelectorAll('.horae-affection-row').forEach(row => {
        const deltaInput = row.querySelector('.affection-delta');
        const totalInput = row.querySelector('.affection-total');
        const prevVal = parseInt(row.dataset.prev) || 0;
        
        deltaInput?.addEventListener('input', () => {
            const deltaStr = deltaInput.value.replace(/[^\d\-+]/g, '');
            const delta = parseInt(deltaStr) || 0;
            totalInput.value = prevVal + delta;
        });
        
        totalInput?.addEventListener('input', () => {
            const total = parseInt(totalInput.value) || 0;
            const delta = total - prevVal;
            deltaInput.value = delta >= 0 ? `+${delta}` : `${delta}`;
        });
    });
}

/** Quét lại tin nhắn và cập nhật bảng điều khiển (thay thế hoàn toàn) */
function rescanMessageMeta(messageId, panelEl) {
    // Lấy nội dung tin nhắn mới nhất từ DOM (người dùng có thể đã sửa)
    const messageEl = panelEl.closest('.mes');
    if (!messageEl) {
        showToast('Không tìm thấy phần tử tin nhắn', 'error');
        return;
    }
    
    // Lấy nội dung văn bản (bao gồm thẻ horae ẩn)
    // Trước tiên thử lấy nội dung mới nhất từ mảng chat
    const context = window.SillyTavern?.getContext?.() || getContext?.();
    let messageContent = '';
    
    if (context?.chat?.[messageId]) {
        messageContent = context.chat[messageId].mes;
    }
    
    // Nếu trong chat không có hoặc rỗng, lấy từ DOM
    if (!messageContent) {
        const mesTextEl = messageEl.querySelector('.mes_text');
        if (mesTextEl) {
            messageContent = mesTextEl.innerHTML;
        }
    }
    
    if (!messageContent) {
        showToast('Không thể lấy nội dung tin nhắn', 'error');
        return;
    }
    
    const parsed = horaeManager.parseHoraeTag(messageContent);
    
    if (parsed) {
        // Thay thế hoàn toàn (không hợp nhất)
        const existingMeta = horaeManager.getMessageMeta(messageId);
        const newMeta = createEmptyMeta();
        
        newMeta.timestamp = parsed.timestamp || {};
        newMeta.scene = parsed.scene || {};
        newMeta.costumes = parsed.costumes || {};
        newMeta.items = parsed.items || {};
        newMeta.deletedItems = parsed.deletedItems || [];
        // Tương thích định dạng sự kiện cũ và mới
        newMeta.events = parsed.events || (parsed.event ? [parsed.event] : []);
        newMeta.affection = parsed.affection || {};
        newMeta.agenda = parsed.agenda || [];
        
        // Chỉ giữ lại dữ liệu NPC cũ (nếu trong lần phân tích mới không có)
        if (parsed.npcs && Object.keys(parsed.npcs).length > 0) {
            newMeta.npcs = parsed.npcs;
        } else if (existingMeta?.npcs) {
            newMeta.npcs = existingMeta.npcs;
        }
        
        // Không có agenda mới thì giữ lại dữ liệu cũ
        if (newMeta.agenda.length === 0 && existingMeta?.agenda?.length > 0) {
            newMeta.agenda = existingMeta.agenda;
        }
        
        // Xử lý việc cần làm đã hoàn thành
        if (parsed.deletedAgenda && parsed.deletedAgenda.length > 0) {
            horaeManager.removeCompletedAgenda(parsed.deletedAgenda);
        }
        
        horaeManager.setMessageMeta(messageId, newMeta);
        getContext().saveChat();
        
        panelEl.remove();
        addMessagePanel(messageEl, messageId);
        
        // Đồng thời làm mới màn hình chính
        refreshAllDisplays();
        
        showToast('Đã quét lại và cập nhật', 'success');
    } else {
        // Không có thẻ, xóa dữ liệu (giữ lại NPC)
        const existingMeta = horaeManager.getMessageMeta(messageId);
        const newMeta = createEmptyMeta();
        if (existingMeta?.npcs) {
            newMeta.npcs = existingMeta.npcs;
        }
        horaeManager.setMessageMeta(messageId, newMeta);
        
        panelEl.remove();
        addMessagePanel(messageEl, messageId);
        refreshAllDisplays();
        
        showToast('Không tìm thấy thẻ Horae, đã xóa dữ liệu', 'warning');
    }
}

/**
 * Lưu dữ liệu bảng điều khiển
 */
function savePanelData(panelEl, messageId) {
    // Lấy meta hiện có, giữ lại dữ liệu không có trong vùng chỉnh sửa của bảng điều khiển (như NPC)
    const existingMeta = horaeManager.getMessageMeta(messageId);
    const meta = createEmptyMeta();
    
    // Giữ lại dữ liệu NPC cũ (vì trong bảng điều khiển không có vùng sửa NPC)
    if (existingMeta?.npcs) {
        meta.npcs = JSON.parse(JSON.stringify(existingMeta.npcs));
    }
    
    // Tách ngày giờ
    const datetimeVal = (panelEl.querySelector('.horae-input-datetime')?.value || '').trim();
    const clockMatch = datetimeVal.match(/\b(\d{1,2}:\d{2})\s*$/);
    if (clockMatch) {
        meta.timestamp.story_time = clockMatch[1];
        meta.timestamp.story_date = datetimeVal.substring(0, datetimeVal.lastIndexOf(clockMatch[1])).trim();
    } else {
        meta.timestamp.story_date = datetimeVal;
        meta.timestamp.story_time = '';
    }
    meta.timestamp.absolute = new Date().toISOString();
    
    // Bối cảnh
    meta.scene.location = panelEl.querySelector('.horae-input-location')?.value || '';
    meta.scene.atmosphere = panelEl.querySelector('.horae-input-atmosphere')?.value || '';
    const charsInput = panelEl.querySelector('.horae-input-characters')?.value || '';
    meta.scene.characters_present = charsInput.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    
    // Trang phục
    panelEl.querySelectorAll('.horae-costume-editor .horae-editor-row').forEach(row => {
        const inputs = row.querySelectorAll('input');
        if (inputs.length >= 2) {
            const char = inputs[0].value.trim();
            const costume = inputs[1].value.trim();
            if (char && costume) {
                meta.costumes[char] = costume;
            }
        }
    });
    
    // Xử lý ghép đôi vật phẩm
    const itemMainRows = panelEl.querySelectorAll('.horae-items-editor .horae-item-row');
    const itemDescRows = panelEl.querySelectorAll('.horae-items-editor .horae-item-desc-row');
    const latestState = horaeManager.getLatestState();
    const existingItems = latestState.items || {};
    
    itemMainRows.forEach((row, idx) => {
        const iconInput = row.querySelector('.item-icon');
        const nameInput = row.querySelector('.item-name');
        const holderInput = row.querySelector('.item-holder');
        const locationInput = row.querySelector('.item-location');
        const descRow = itemDescRows[idx];
        const descInput = descRow?.querySelector('.item-description');
        
        if (nameInput) {
            const name = nameInput.value.trim();
            if (name) {
                // Lấy importance đã lưu từ kho đồ, thanh dưới cùng không chỉnh sửa phân loại
                const existingImportance = existingItems[name]?.importance || existingMeta?.items?.[name]?.importance || '';
                meta.items[name] = {
                    icon: iconInput?.value.trim() || null,
                    importance: existingImportance,  // Giữ phân loại của kho đồ
                    holder: holderInput?.value.trim() || null,
                    location: locationInput?.value.trim() || '',
                    description: descInput?.value.trim() || ''
                };
            }
        }
    });
    
    // Sự kiện
    const eventLevel = panelEl.querySelector('.horae-input-event-level')?.value;
    const eventSummary = panelEl.querySelector('.horae-input-event-summary')?.value;
    if (eventLevel && eventSummary) {
        meta.events = [{
            is_important: eventLevel === '重要' || eventLevel === '关键',
            level: eventLevel,
            summary: eventSummary
        }];
    }
    
    panelEl.querySelectorAll('.horae-affection-editor .horae-affection-row').forEach(row => {
        const charSpan = row.querySelector('.affection-char');
        const charInput = row.querySelector('.affection-char-input');
        const totalInput = row.querySelector('.affection-total');
        
        const key = charSpan?.textContent?.trim() || charInput?.value?.trim() || '';
        const total = parseInt(totalInput?.value) || 0;
        
        if (key) {
            meta.affection[key] = { type: 'absolute', value: total };
        }
    });
    
    // Tương thích định dạng cũ
    panelEl.querySelectorAll('.horae-affection-editor .horae-editor-row:not(.horae-affection-row)').forEach(row => {
        const inputs = row.querySelectorAll('input');
        if (inputs.length >= 2) {
            const key = inputs[0].value.trim();
            const value = inputs[1].value.trim();
            if (key && value) {
                meta.affection[key] = value;
            }
        }
    });
    
    const agendaItems = [];
    panelEl.querySelectorAll('.horae-agenda-editor .horae-agenda-edit-row').forEach(row => {
        const dateInput = row.querySelector('.agenda-date');
        const textInput = row.querySelector('.agenda-text');
        const date = dateInput?.value?.trim() || '';
        const text = textInput?.value?.trim() || '';
        if (text) {
            // Giữ nguyên source
            const existingAgendaItem = existingMeta?.agenda?.find(a => a.text === text);
            const source = existingAgendaItem?.source || 'user';
            agendaItems.push({ date, text, source, done: false });
        }
    });
    if (agendaItems.length > 0) {
        meta.agenda = agendaItems;
    } else if (existingMeta?.agenda?.length > 0) {
        // Không có hàng sửa thì giữ lại việc cần làm cũ
        meta.agenda = existingMeta.agenda;
    }
    
    horaeManager.setMessageMeta(messageId, meta);
    
    // Đồng bộ ghi thẻ vào nội dung chính
    injectHoraeTagToMessage(messageId, meta);
    
    getContext().saveChat();
    
    showToast('Lưu thành công!', 'success');
    refreshAllDisplays();
    
    // Cập nhật tóm tắt bảng điều khiển
    const summaryTime = panelEl.querySelector('.horae-summary-time');
    const summaryEvent = panelEl.querySelector('.horae-summary-event');
    const summaryChars = panelEl.querySelector('.horae-summary-chars');
    
    if (summaryTime) {
        if (meta.timestamp.story_date) {
            const parsed = parseStoryDate(meta.timestamp.story_date);
            let dateDisplay = meta.timestamp.story_date;
            if (parsed && parsed.type === 'standard') {
                dateDisplay = formatStoryDate(parsed, true);
            }
            summaryTime.textContent = dateDisplay + (meta.timestamp.story_time ? ' ' + meta.timestamp.story_time : '');
        } else {
            summaryTime.textContent = '--';
        }
    }
    if (summaryEvent) {
        summaryEvent.textContent = meta.event?.summary || 'Không có sự kiện đặc biệt';
    }
    if (summaryChars) {
        summaryChars.textContent = `${meta.scene.characters_present.length} người có mặt`;
    }
}

/** Xây dựng chuỗi thẻ <horae> từ meta */
function buildHoraeTagFromMeta(meta) {
    const lines = [];
    
    if (meta.timestamp?.story_date) {
        let timeLine = `time:${meta.timestamp.story_date}`;
        if (meta.timestamp.story_time) timeLine += ` ${meta.timestamp.story_time}`;
        lines.push(timeLine);
    }
    
    if (meta.scene?.location) {
        lines.push(`location:${meta.scene.location}`);
    }
    
    if (meta.scene?.atmosphere) {
        lines.push(`atmosphere:${meta.scene.atmosphere}`);
    }
    
    if (meta.scene?.characters_present?.length > 0) {
        lines.push(`characters:${meta.scene.characters_present.join(',')}`);
    }
    
    if (meta.costumes) {
        for (const [char, costume] of Object.entries(meta.costumes)) {
            if (char && costume) {
                lines.push(`costume:${char}=${costume}`);
            }
        }
    }
    
    if (meta.items) {
        for (const [name, info] of Object.entries(meta.items)) {
            if (!name) continue;
            const imp = info.importance === '!!' ? '!!' : info.importance === '!' ? '!' : '';
            const icon = info.icon || '';
            const desc = info.description ? `|${info.description}` : '';
            const holder = info.holder || '';
            const loc = info.location ? `@${info.location}` : '';
            lines.push(`item${imp}:${icon}${name}${desc}=${holder}${loc}`);
        }
    }
    
    // deleted items
    if (meta.deletedItems?.length > 0) {
        for (const item of meta.deletedItems) {
            lines.push(`item-:${item}`);
        }
    }
    
    if (meta.affection) {
        for (const [name, value] of Object.entries(meta.affection)) {
            if (!name) continue;
            if (typeof value === 'object') {
                if (value.type === 'relative') {
                    lines.push(`affection:${name}${value.value}`);
                } else {
                    lines.push(`affection:${name}=${value.value}`);
                }
            } else {
                lines.push(`affection:${name}=${value}`);
            }
        }
    }
    
    // npcs (sử dụng định dạng mới: npc:Tên|Ngoại hình=Tính cách@Quan hệ~Trường mở rộng)
    if (meta.npcs) {
        for (const [name, info] of Object.entries(meta.npcs)) {
            if (!name) continue;
            const app = info.appearance || '';
            const per = info.personality || '';
            const rel = info.relationship || '';
            let npcLine = '';
            if (app || per || rel) {
                npcLine = `npc:${name}|${app}=${per}@${rel}`;
            } else {
                npcLine = `npc:${name}`;
            }
            const extras = [];
            if (info.gender) extras.push(`性别:${info.gender}`);
            if (info.age) extras.push(`年龄:${info.age}`);
            if (info.race) extras.push(`种族:${info.race}`);
            if (info.job) extras.push(`职业:${info.job}`);
            if (info.note) extras.push(`补充:${info.note}`);
            if (extras.length > 0) npcLine += `~${extras.join('~')}`;
            lines.push(npcLine);
        }
    }
    
    if (meta.agenda?.length > 0) {
        for (const item of meta.agenda) {
            if (item.text) {
                const datePart = item.date ? `${item.date}|` : '';
                lines.push(`agenda:${datePart}${item.text}`);
            }
        }
    }
    
    if (lines.length === 0) return '';
    return `<horae>\n${lines.join('\n')}\n</horae>`;
}

/** Xây dựng chuỗi thẻ <horaeevent> từ meta */
function buildHoraeEventTagFromMeta(meta) {
    const events = meta.events || (meta.event ? [meta.event] : []);
    if (events.length === 0) return '';
    
    const lines = events
        .filter(e => e.summary)
        .map(e => `event:${e.level || '一般'}|${e.summary}`);
    
    if (lines.length === 0) return '';
    return `<horaeevent>\n${lines.join('\n')}\n</horaeevent>`;
}

/** Đồng bộ tiêm thẻ vào nội dung tin nhắn */
function injectHoraeTagToMessage(messageId, meta) {
    try {
        const chat = horaeManager.getChat();
        if (!chat?.[messageId]) return;
        
        const message = chat[messageId];
        let mes = message.mes;
        
        // === Xử lý thẻ <horae> ===
        const newHoraeTag = buildHoraeTagFromMeta(meta);
        const hasHoraeTag = /<horae>[\s\S]*?<\/horae>/i.test(mes);
        
        if (hasHoraeTag) {
            mes = newHoraeTag
                ? mes.replace(/<horae>[\s\S]*?<\/horae>/gi, newHoraeTag)
                : mes.replace(/<horae>[\s\S]*?<\/horae>/gi, '').trim();
        } else if (newHoraeTag) {
            mes = mes.trimEnd() + '\n\n' + newHoraeTag;
        }
        
        // === Xử lý thẻ <horaeevent> ===
        const newEventTag = buildHoraeEventTagFromMeta(meta);
        const hasEventTag = /<horaeevent>[\s\S]*?<\/horaeevent>/i.test(mes);
        
        if (hasEventTag) {
            mes = newEventTag
                ? mes.replace(/<horaeevent>[\s\S]*?<\/horaeevent>/gi, newEventTag)
                : mes.replace(/<horaeevent>[\s\S]*?<\/horaeevent>/gi, '').trim();
        } else if (newEventTag) {
            mes = mes.trimEnd() + '\n' + newEventTag;
        }
        
        message.mes = mes;
        console.log(`[Horae] Đã đồng bộ ghi thẻ tin nhắn #${messageId}`);
    } catch (error) {
        console.error(`[Horae] Ghi thẻ thất bại:`, error);
    }
}

// ============================================
// Tương tác ngăn kéo
// ============================================

/**
 * Mở/Đóng ngăn kéo (Chế độ tương thích cũ)
 */
function openDrawerLegacy() {
    const drawerIcon = $('#horae_drawer_icon');
    const drawerContent = $('#horae_drawer_content');
    
    if (drawerIcon.hasClass('closedIcon')) {
        // Đóng các ngăn kéo khác
        $('.openDrawer').not('#horae_drawer_content').not('.pinnedOpen').addClass('resizing').each((_, el) => {
            slideToggle(el, {
                ...getSlideToggleOptions(),
                onAnimationEnd: (elem) => elem.closest('.drawer-content')?.classList.remove('resizing'),
            });
        });
        $('.openIcon').not('#horae_drawer_icon').not('.drawerPinnedOpen').toggleClass('closedIcon openIcon');
        $('.openDrawer').not('#horae_drawer_content').not('.pinnedOpen').toggleClass('closedDrawer openDrawer');

        drawerIcon.toggleClass('closedIcon openIcon');
        drawerContent.toggleClass('closedDrawer openDrawer');

        drawerContent.addClass('resizing').each((_, el) => {
            slideToggle(el, {
                ...getSlideToggleOptions(),
                onAnimationEnd: (elem) => elem.closest('.drawer-content')?.classList.remove('resizing'),
            });
        });
    } else {
        drawerIcon.toggleClass('openIcon closedIcon');
        drawerContent.toggleClass('openDrawer closedDrawer');

        drawerContent.addClass('resizing').each((_, el) => {
            slideToggle(el, {
                ...getSlideToggleOptions(),
                onAnimationEnd: (elem) => elem.closest('.drawer-content')?.classList.remove('resizing'),
            });
        });
    }
}

/**
 * Khởi tạo ngăn kéo
 */
async function initDrawer() {
    const toggle = $('#horae_drawer .drawer-toggle');
    
    if (isNewNavbarVersion()) {
        toggle.on('click', doNavbarIconClick);
        console.log(`[Horae] Sử dụng chế độ thanh điều hướng mới`);
    } else {
        $('#horae_drawer_content').attr('data-slide-toggle', 'hidden').css('display', 'none');
        toggle.on('click', openDrawerLegacy);
        console.log(`[Horae] Sử dụng chế độ ngăn kéo cũ`);
    }
}

/**
 * Khởi tạo chuyển đổi tab
 */
function initTabs() {
    $('.horae-tab').on('click', function() {
        const tabId = $(this).data('tab');
        
        $('.horae-tab').removeClass('active');
        $(this).addClass('active');
        
        $('.horae-tab-content').removeClass('active');
        $(`#horae-tab-${tabId}`).addClass('active');
        
        switch(tabId) {
            case 'status':
                updateStatusDisplay();
                break;
            case 'timeline':
                updateAgendaDisplay();
                updateTimelineDisplay();
                break;
            case 'characters':
                updateCharactersDisplay();
                break;
            case 'items':
                updateItemsDisplay();
                break;
        }
    });
}

// ============================================
// Chức năng dọn dẹp vật phẩm vô chủ
// ============================================

/**
 * Khởi tạo sự kiện trang cài đặt
 */
function initSettingsEvents() {
    $('#horae-setting-enabled').on('change', function() {
        settings.enabled = this.checked;
        saveSettings();
    });
    
    $('#horae-setting-auto-parse').on('change', function() {
        settings.autoParse = this.checked;
        saveSettings();
    });
    
    $('#horae-setting-inject-context').on('change', function() {
        settings.injectContext = this.checked;
        saveSettings();
    });
    
    $('#horae-setting-show-panel').on('change', function() {
        settings.showMessagePanel = this.checked;
        saveSettings();
        document.querySelectorAll('.horae-message-panel').forEach(panel => {
            panel.style.display = this.checked ? '' : 'none';
        });
    });
    
    $('#horae-setting-context-depth').on('change', function() {
        settings.contextDepth = parseInt(this.value) || 15;
        saveSettings();
    });
    
    $('#horae-setting-injection-position').on('change', function() {
        settings.injectionPosition = parseInt(this.value) || 1;
        saveSettings();
    });
    
    $('#horae-btn-scan-all, #horae-btn-scan-history').on('click', scanHistoryWithProgress);
    
    $('#horae-timeline-filter').on('change', updateTimelineDisplay);
    $('#horae-timeline-search').on('input', updateTimelineDisplay);
    
    $('#horae-btn-add-agenda').on('click', () => openAgendaEditModal(null));
    
    $('#horae-btn-agenda-select-all').on('click', selectAllAgenda);
    $('#horae-btn-agenda-delete').on('click', deleteSelectedAgenda);
    $('#horae-btn-agenda-cancel-select').on('click', exitAgendaMultiSelect);
    
    $('#horae-items-search').on('input', updateItemsDisplay);
    $('#horae-items-filter').on('change', updateItemsDisplay);
    $('#horae-items-holder-filter').on('change', updateItemsDisplay);
    
    $('#horae-btn-items-select-all').on('click', selectAllItems);
    $('#horae-btn-items-delete').on('click', deleteSelectedItems);
    $('#horae-btn-items-cancel-select').on('click', exitMultiSelectMode);
    
    $('#horae-btn-items-refresh').on('click', () => {
        updateItemsDisplay();
        showToast('Đã làm mới danh sách vật phẩm', 'info');
    });
    
    $('#horae-setting-send-timeline').on('change', function() {
        settings.sendTimeline = this.checked;
        saveSettings();
        horaeManager.init(getContext(), settings);
    });
    
    $('#horae-setting-send-characters').on('change', function() {
        settings.sendCharacters = this.checked;
        saveSettings();
        horaeManager.init(getContext(), settings);
    });
    
    $('#horae-setting-send-items').on('change', function() {
        settings.sendItems = this.checked;
        saveSettings();
        horaeManager.init(getContext(), settings);
    });
    
    $('#horae-btn-refresh').on('click', refreshAllDisplays);
    
    $('#horae-btn-add-table').on('click', addNewExcelTable);
    $('#horae-btn-import-table').on('click', () => {
        $('#horae-import-table-file').trigger('click');
    });
    $('#horae-import-table-file').on('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            importTable(file);
            e.target.value = ''; // Xóa để có thể chọn lại cùng một tệp
        }
    });
    renderCustomTablesList();
    
    $('#horae-btn-export').on('click', exportData);
    $('#horae-btn-import').on('click', importData);
    $('#horae-btn-clear').on('click', clearAllData);
}

/**
 * Đồng bộ cài đặt vào UI
 */
function syncSettingsToUI() {
    $('#horae-setting-enabled').prop('checked', settings.enabled);
    $('#horae-setting-auto-parse').prop('checked', settings.autoParse);
    $('#horae-setting-inject-context').prop('checked', settings.injectContext);
    $('#horae-setting-show-panel').prop('checked', settings.showMessagePanel);
    $('#horae-setting-context-depth').val(settings.contextDepth);
    $('#horae-setting-injection-position').val(settings.injectionPosition);
    $('#horae-setting-send-timeline').prop('checked', settings.sendTimeline);
    $('#horae-setting-send-characters').prop('checked', settings.sendCharacters);
    $('#horae-setting-send-items').prop('checked', settings.sendItems);
}

// ============================================
// Chức năng cốt lõi
// ============================================

/**
 * Quét lịch sử với hiển thị tiến độ
 */
async function scanHistoryWithProgress() {
    const overlay = document.createElement('div');
    overlay.className = 'horae-progress-overlay';
    overlay.innerHTML = `
        <div class="horae-progress-container">
            <div class="horae-progress-title">Đang quét lịch sử...</div>
            <div class="horae-progress-bar">
                <div class="horae-progress-fill" style="width: 0%"></div>
            </div>
            <div class="horae-progress-text">Đang chuẩn bị...</div>
        </div>
    `;
    document.body.appendChild(overlay);
    
    const fillEl = overlay.querySelector('.horae-progress-fill');
    const textEl = overlay.querySelector('.horae-progress-text');
    
    try {
        const result = await horaeManager.scanAndInjectHistory(
            (percent, current, total) => {
                fillEl.style.width = `${percent}%`;
                textEl.textContent = `Đang xử lý... ${current}/${total}`;
            },
            null // Không sử dụng AI phân tích, chỉ phân tích thẻ có sẵn
        );
        
        horaeManager.rebuildTableData();
        
        await getContext().saveChat();
        
        showToast(`Quét hoàn tất! Đã xử lý ${result.processed} mục, bỏ qua ${result.skipped} mục`, 'success');
        refreshAllDisplays();
        renderCustomTablesList();
    } catch (error) {
        console.error('[Horae] Quét thất bại:', error);
        showToast('Quét thất bại: ' + error.message, 'error');
    } finally {
        overlay.remove();
    }
}

/**
 * Xuất dữ liệu
 */
function exportData() {
    const chat = horaeManager.getChat();
    const exportObj = {
        version: VERSION,
        exportTime: new Date().toISOString(),
        data: chat.map((msg, index) => ({
            index,
            horae_meta: msg.horae_meta || null
        })).filter(item => item.horae_meta)
    };
    
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `horae_export_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    showToast('Dữ liệu đã được xuất', 'success');
}

/**
 * Nhập dữ liệu
 */
function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        try {
            const text = await file.text();
            const importObj = JSON.parse(text);
            
            if (!importObj.data || !Array.isArray(importObj.data)) {
                throw new Error('Định dạng dữ liệu không hợp lệ');
            }
            
            const chat = horaeManager.getChat();
            let imported = 0;
            
            for (const item of importObj.data) {
                if (item.index >= 0 && item.index < chat.length && item.horae_meta) {
                    chat[item.index].horae_meta = item.horae_meta;
                    imported++;
                }
            }
            
            await getContext().saveChat();
            showToast(`Nhập thành công ${imported} bản ghi`, 'success');
            refreshAllDisplays();
        } catch (error) {
            console.error('[Horae] Nhập thất bại:', error);
            showToast('Nhập thất bại: ' + error.message, 'error');
        }
    };
    input.click();
}

/**
 * Xóa tất cả dữ liệu
 */
async function clearAllData() {
    if (!confirm('Bạn có chắc muốn xóa tất cả siêu dữ liệu Horae không? Thao tác này không thể khôi phục!')) {
        return;
    }
    
    const chat = horaeManager.getChat();
    for (const msg of chat) {
        delete msg.horae_meta;
    }
    
    await getContext().saveChat();
    showToast('Tất cả dữ liệu đã bị xóa', 'warning');
    refreshAllDisplays();
}

/** Sử dụng AI để phân tích nội dung tin nhắn */
async function analyzeMessageWithAI(messageContent) {
    const context = getContext();
    
    const userName = context?.name1 || 'Nhân vật chính';
    
    const analysisPrompt = `Vui lòng phân tích văn bản sau đây, trích xuất thông tin quan trọng và xuất ra theo định dạng được chỉ định. Nguyên tắc cốt lõi: Chỉ trích xuất thông tin được đề cập rõ ràng trong văn bản, không ghi các trường không có, nghiêm cấm bịa đặt.

【Nội dung văn bản】
${messageContent}

【Định dạng đầu ra】
<horae>
time:Ngày Giờ (Bắt buộc, ví dụ 2026/2/4 15:00 hoặc Ngày đầu tiên tháng Sương Giá 19:50)
location:Địa điểm hiện tại (Bắt buộc)
atmosphere:Bầu không khí
characters:Nhân vật có mặt, phân cách bằng dấu phẩy (Bắt buộc)
costume:Tên nhân vật=Mô tả trang phục đầy đủ (Bắt buộc, mỗi người một dòng, cấm gộp bằng dấu chấm phẩy)
item:emojiTên vật phẩm(Số lượng)|Mô tả=Người sở hữu@Vị trí chính xác (Chỉ những vật phẩm mới nhận hoặc có thay đổi)
item!:emojiTên vật phẩm(Số lượng)|Mô tả=Người sở hữu@Vị trí chính xác (Vật phẩm quan trọng, mô tả bắt buộc)
item!!:emojiTên vật phẩm(Số lượng)|Mô tả=Người sở hữu@Vị trí chính xác (Đạo cụ then chốt, mô tả phải chi tiết)
item-:Tên vật phẩm (Vật phẩm tiêu hao/mất)
affection:Tên nhân vật=Giá trị hảo cảm (Chỉ NPC đối với ${userName}, cấm ghi ${userName} tự mình, cấm thêm chú thích sau giá trị số)
npc:Tên nhân vật|Ngoại hình=Tính cách@Quan hệ với ${userName}~Giới tính:Nam hoặc Nữ~Tuổi:Số~Chủng tộc:Tên chủng tộc~Nghề nghiệp:Tên nghề nghiệp
agenda:Ngày thiết lập|Nội dung việc cần làm (Chỉ ghi khi xuất hiện giao kèo/kế hoạch/ẩn ý mới, thời gian tương đối phải chú thích ngày tuyệt đối trong ngoặc)
agenda-:Từ khóa nội dung (Ghi khi việc cần làm đã hoàn thành/hết hiệu lực/hủy bỏ, hệ thống tự động xóa việc cần làm khớp)
</horae>
<horaeevent>
event:Mức độ quan trọng|Tóm tắt sự kiện (30-50 từ, Bình thường/Quan trọng/Then chốt)
</horaeevent>

【Điều kiện kích hoạt】Chỉ xuất các trường tương ứng khi thỏa mãn điều kiện:
· Vật phẩm: Chỉ ghi khi mới nhận được, thay đổi số lượng/quyền sở hữu/vị trí, tiêu hao mất đi. Không thay đổi không ghi. Đồ đơn lẻ không ghi (1). Tiền tố emoji như 🔑🍞.
· NPC: Lần đầu xuất hiện bắt buộc phải đầy đủ (bao gồm ~Giới tính/Tuổi/Chủng tộc/Nghề nghiệp). Sau đó chỉ ghi các trường thay đổi, không thay đổi không ghi.
  Dấu phân cách: | phân tên, = phân ngoại hình và tính cách, @ phân quan hệ, ~ phân trường mở rộng
· Hảo cảm: Lần đầu xác định theo quan hệ (Người lạ 0-20/Người quen 30-50/Bạn bè 50-70), sau đó chỉ ghi khi thay đổi.
· Việc cần làm: Chỉ ghi khi xuất hiện giao kèo/kế hoạch/ẩn ý mới. Việc cần làm đã hoàn thành/hết hiệu lực dùng agenda-: để xóa.
  Thêm mới: agenda:2026/02/10|Allen mời ${userName} hẹn hò tối Valentine (2026/02/14 18:00)
  Hoàn thành: agenda-:Allen mời ${userName} hẹn hò tối Valentine
· event: Đặt trong <horaeevent>, không đặt trong <horae>.`;

    try {
        const response = await context.generateRaw(analysisPrompt, null, false, false);
        
        if (response) {
            const parsed = horaeManager.parseHoraeTag(response);
            return parsed;
        }
    } catch (error) {
        console.error('[Horae] Gọi AI Phân tích thất bại:', error);
        throw error;
    }
    
    return null;
}

// ============================================
// Lắng nghe sự kiện
// ============================================

/**
 * Kích hoạt khi nhận được phản hồi AI
 */
async function onMessageReceived(messageId) {
    if (!settings.enabled || !settings.autoParse) return;
    
    const chat = horaeManager.getChat();
    const message = chat[messageId];
    
    if (!message || message.is_user) return;
    
    console.log(`[Horae] Xử lý tin nhắn mới #${messageId}`);
    
    const hasTag = horaeManager.processAIResponse(messageId, message.mes);
    
    if (hasTag) {
        console.log(`[Horae] Đã phân tích được siêu dữ liệu từ tin nhắn #${messageId}`);
    }
    
    getContext().saveChat();
    refreshAllDisplays();
    renderCustomTablesList();
    
    setTimeout(() => {
        const messageEl = document.querySelector(`.mes[mesid="${messageId}"]`);
        if (messageEl) {
            addMessagePanel(messageEl, messageId);
        }
    }, 100);
}

/**
 * Kích hoạt khi tin nhắn bị xóa — Xây dựng lại dữ liệu bảng
 */
function onMessageDeleted() {
    if (!settings.enabled) return;
    
    console.log('[Horae] Phát hiện tin nhắn bị xóa, đang xây dựng lại dữ liệu bảng...');
    horaeManager.rebuildTableData();
    getContext().saveChat();
    
    refreshAllDisplays();
    renderCustomTablesList();
}

/**
 * Kích hoạt khi tin nhắn được chỉnh sửa — Phân tích lại tin nhắn đó và xây dựng lại bảng
 */
function onMessageEdited(messageId) {
    if (!settings.enabled) return;
    
    const chat = horaeManager.getChat();
    const message = chat[messageId];
    if (!message || message.is_user) return;
    
    console.log(`[Horae] Phát hiện tin nhắn #${messageId} được chỉnh sửa, đang phân tích lại...`);
    
    // Phân tích lại tin nhắn này
    horaeManager.processAIResponse(messageId, message.mes);
    
    horaeManager.rebuildTableData();
    getContext().saveChat();
    
    refreshAllDisplays();
    renderCustomTablesList();
}

/**
 * Chuẩn bị tiêm ngữ cảnh
 */
async function onPromptReady(eventData) {
    if (!settings.enabled || !settings.injectContext) return;
    if (eventData.dryRun) return;
    
    try {
        const prompt = horaeManager.generateCompactPrompt();
        const systemAddition = horaeManager.generateSystemPromptAddition();
        
        const combinedPrompt = `${prompt}\n${systemAddition}`;
        
        // Tiêm vào ngữ cảnh
        const position = settings.injectionPosition;
        if (position === 0) {
            eventData.chat.push({ role: 'system', content: combinedPrompt });
    } else {
            eventData.chat.splice(-position, 0, { role: 'system', content: combinedPrompt });
        }
        
        console.log(`[Horae] Đã tiêm ngữ cảnh, vị trí: -${position}`);
    } catch (error) {
        console.error('[Horae] Tiêm ngữ cảnh thất bại:', error);
    }
}

/**
 * Kích hoạt khi chuyển đổi cuộc trò chuyện
 */
async function onChatChanged() {
    if (!settings.enabled) return;
    
    horaeManager.init(getContext(), settings);
    
    refreshAllDisplays();
    renderCustomTablesList();
    
    setTimeout(() => {
        document.querySelectorAll('.mes:not(.horae-processed)').forEach(messageEl => {
            const messageId = parseInt(messageEl.getAttribute('mesid'));
            if (!isNaN(messageId)) {
                const msg = horaeManager.getChat()[messageId];
                if (msg && !msg.is_user && msg.horae_meta) {
                    addMessagePanel(messageEl, messageId);
                }
                messageEl.classList.add('horae-processed');
            }
        });
    }, 500);
}

/**
 * Kích hoạt khi tin nhắn được render
 */
function onMessageRendered(messageId) {
    if (!settings.enabled || !settings.showMessagePanel) return;
    
    setTimeout(() => {
        const messageEl = document.querySelector(`.mes[mesid="${messageId}"]`);
        if (messageEl) {
            const msg = horaeManager.getChat()[messageId];
            if (msg && !msg.is_user) {
                addMessagePanel(messageEl, messageId);
                messageEl.classList.add('horae-processed');
            }
        }
    }, 100);
}

// ============================================
// Khởi tạo
// ============================================

jQuery(async () => {
    console.log(`[Horae] Bắt đầu tải v${VERSION}...`);

    await initNavbarFunction();
    loadSettings();
    ensureRegexRules();
    
    $('#extensions-settings-button').after(await getTemplate('drawer'));

    await initDrawer();
    initTabs();
    initSettingsEvents();
    syncSettingsToUI();
    
    horaeManager.init(getContext(), settings);
    
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.MESSAGE_SWIPED, onMessageRendered); // Sửa lỗi panel biến mất sau khi vuốt
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted); // Xây dựng lại dữ liệu bảng khi tin nhắn bị xóa
    eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);   // Xây dựng lại dữ liệu bảng khi tin nhắn được sửa
    
    refreshAllDisplays();
    
    isInitialized = true;
    console.log(`[Horae] v${VERSION} Tải hoàn tất! Tác giả: SenriYuki`);
});