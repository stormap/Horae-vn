/**
 * Horae - Trình quản lý cốt lõi
 * Chịu trách nhiệm lưu trữ, phân tích và tổng hợp siêu dữ liệu
 */

import { parseStoryDate, calculateRelativeTime, calculateDetailedRelativeTime, generateTimeReference, formatRelativeTime, formatFullDateTime } from '../utils/timeUtils.js';

/**
 * @typedef {Object} HoraeTimestamp
 * @property {string} story_date - Ngày cốt truyện, ví dụ "10/1"
 * @property {string} story_time - Thời gian cốt truyện, ví dụ "15:00" hoặc "Buổi chiều"
 * @property {string} absolute - Dấu thời gian thực tế định dạng ISO
 */

/**
 * @typedef {Object} HoraeScene
 * @property {string} location - Địa điểm bối cảnh
 * @property {string[]} characters_present - Danh sách nhân vật có mặt
 * @property {string} atmosphere - Bầu không khí
 */

/**
 * @typedef {Object} HoraeEvent
 * @property {boolean} is_important - Có phải sự kiện quan trọng không
 * @property {string} level - Cấp độ sự kiện: Bình thường/Quan trọng/Then chốt
 * @property {string} summary - Tóm tắt sự kiện
 */

/**
 * @typedef {Object} HoraeItemInfo
 * @property {string|null} icon - Biểu tượng emoji
 * @property {string|null} holder - Người sở hữu
 * @property {string} location - Mô tả vị trí
 */

/**
 * @typedef {Object} HoraeMeta
 * @property {HoraeTimestamp} timestamp
 * @property {HoraeScene} scene
 * @property {Object.<string, string>} costumes - Trang phục nhân vật {Tên nhân vật: Mô tả trang phục}
 * @property {Object.<string, HoraeItemInfo>} items - Theo dõi vật phẩm
 * @property {HoraeEvent|null} event
 * @property {Object.<string, string|number>} affection - Hảo cảm
 * @property {Object.<string, {description: string, first_seen: string}>} npcs - NPC tạm thời
 */

/** Tạo đối tượng meta rỗng */
export function createEmptyMeta() {
    return {
        timestamp: {
            story_date: '',
            story_time: '',
            absolute: ''
        },
        scene: {
            location: '',
            characters_present: [],
            atmosphere: ''
        },
        costumes: {},
        items: {},
        deletedItems: [],  // Danh sách tên vật phẩm đã tiêu hao/xóa
        events: [],  // Hỗ trợ nhiều sự kiện
        affection: {},
        npcs: {},
        agenda: []   // Việc cần làm
    };
}

/**
 * Trích xuất tên cơ bản của vật phẩm (loại bỏ dấu ngoặc số lượng ở cuối)
 * "Xương bò tươi(5 cân)" → "Xương bò tươi"
 * "Nước sạch(9L)" → "Nước sạch"
 * "Túi cứu thương" → "Túi cứu thương" (Không có số lượng, giữ nguyên)
 * "Túi cứu thương(Đã mở)" → Giữ nguyên (Ngoặc không bắt đầu bằng số)
 */
// Lượng từ cá thể: 1 cái = chỉ một cái, có thể lược bỏ. Lượng từ thuần túy (cái)(chiếc) cũng vô nghĩa
// Chuỗi này chứa các lượng từ tiếng Trung và một số lượng từ tiếng Việt phổ biến để lọc
const COUNTING_CLASSIFIERS = '个把条块张根口份枚只颗支件套双对碗杯盘盆串束扎cái chiếc con cây quyển tờ viên hạt bộ đôi cặp bát chén đĩa ly cốc xâu bó';
// Đơn vị chứa/lô: 1 thùng = Một thùng (bên trong có nhiều), không thể lược bỏ
// Đơn vị đo lường (cân/L/kg...): Có ý nghĩa đo lường thực tế, không thể lược bỏ

// ID vật phẩm: 3 chữ số đệm số 0, ví dụ 001, 002...
function padItemId(id) { return String(id).padStart(3, '0'); }

function getItemBaseName(name) {
    return name
        .replace(/[\(（][\d][\d\.\/]*[a-zA-Z\u4e00-\u9fff]*[\)）]$/, '')  // Số + đơn vị bất kỳ
        .replace(new RegExp(`[\\(（][${COUNTING_CLASSIFIERS}][\\)）]$`), '')  // Lượng từ cá thể thuần túy (AI định dạng sai)
        .trim();
}

/** Tìm vật phẩm đã có theo tên cơ bản */
function findExistingItemByBaseName(stateItems, newName) {
    const newBase = getItemBaseName(newName);
    if (stateItems[newName]) return newName;
    for (const existingName of Object.keys(stateItems)) {
        if (getItemBaseName(existingName) === newBase) {
            return existingName;
        }
    }
    return null;
}

/** Trình quản lý Horae */
class HoraeManager {
    constructor() {
        this.context = null;
        this.settings = null;
    }

    /** Khởi tạo trình quản lý */
    init(context, settings) {
        this.context = context;
        this.settings = settings;
    }

    /** Lấy lịch sử trò chuyện hiện tại */
    getChat() {
        return this.context?.chat || [];
    }

    /** Lấy meta của tin nhắn */
    getMessageMeta(messageIndex) {
        const chat = this.getChat();
        if (messageIndex < 0 || messageIndex >= chat.length) return null;
        return chat[messageIndex].horae_meta || null;
    }

    /** Thiết lập meta cho tin nhắn */
    setMessageMeta(messageIndex, meta) {
        const chat = this.getChat();
        if (messageIndex < 0 || messageIndex >= chat.length) return;
        chat[messageIndex].horae_meta = meta;
    }

    /** Tổng hợp meta của tất cả tin nhắn, lấy trạng thái mới nhất */
    getLatestState() {
        const chat = this.getChat();
        const state = createEmptyMeta();
        
        // Duyệt từ đầu đến cuối, cái sau ghi đè cái trước
        for (let i = 0; i < chat.length; i++) {
            const meta = chat[i].horae_meta;
            if (!meta) continue;
            
            if (meta.timestamp?.story_date) {
                state.timestamp.story_date = meta.timestamp.story_date;
            }
            if (meta.timestamp?.story_time) {
                state.timestamp.story_time = meta.timestamp.story_time;
            }
            
            if (meta.scene?.location) {
                state.scene.location = meta.scene.location;
            }
            if (meta.scene?.atmosphere) {
                state.scene.atmosphere = meta.scene.atmosphere;
            }
            if (meta.scene?.characters_present?.length > 0) {
                state.scene.characters_present = [...meta.scene.characters_present];
            }
            
            if (meta.costumes) {
                Object.assign(state.costumes, meta.costumes);
            }
            
            // Vật phẩm: Hợp nhất cập nhật
            if (meta.items) {
                for (let [name, newInfo] of Object.entries(meta.items)) {
                    // Loại bỏ dấu lượng từ vô nghĩa
                    // (1) Số 1 trần → Bỏ
                    name = name.replace(/[\(（]1[\)）]$/, '').trim();
                    // Lượng từ cá thể + số 1 → Bỏ
                    name = name.replace(new RegExp(`[\\(（]1[${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                    // Lượng từ cá thể thuần túy → Bỏ
                    name = name.replace(new RegExp(`[\\(（][${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                    // Đơn vị đo lường/chứa giữ nguyên
                    
                    // Số lượng là 0 coi như tiêu hao, tự động xóa
                    const zeroMatch = name.match(/[\(（]0[a-zA-Z\u4e00-\u9fff]*[\)）]$/);
                    if (zeroMatch) {
                        const baseName = getItemBaseName(name);
                        for (const itemName of Object.keys(state.items)) {
                            if (getItemBaseName(itemName).toLowerCase() === baseName.toLowerCase()) {
                                delete state.items[itemName];
                                console.log(`[Horae] Vật phẩm số lượng về 0 tự động xóa: ${itemName}`);
                            }
                        }
                        continue;
                    }
                    
                    // Kiểm tra đánh dấu trạng thái tiêu hao, coi như xóa (Hỗ trợ tiếng Việt)
                    const consumedPatterns = /[\(（](已消耗|已用完|已销毁|消耗殆尽|消耗|用尽|Đã dùng|Đã tiêu hao|Đã dùng hết|Hết|Cạn kiệt)[\)）]/i;
                    const holderConsumed = /^(消耗|已消耗|已用完|消耗殆尽|用尽|无|Đã dùng|Đã tiêu hao|Đã dùng hết|Hết|Không còn)$/i;
                    if (consumedPatterns.test(name) || holderConsumed.test(newInfo.holder || '')) {
                        const cleanName = name.replace(consumedPatterns, '').trim();
                        const baseName = getItemBaseName(cleanName || name);
                        for (const itemName of Object.keys(state.items)) {
                            if (getItemBaseName(itemName).toLowerCase() === baseName.toLowerCase()) {
                                delete state.items[itemName];
                                console.log(`[Horae] Vật phẩm đã tiêu hao tự động xóa: ${itemName}`);
                            }
                        }
                        continue;
                    }
                    
                    // Khớp tên cơ bản với vật phẩm đã có
                    const existingKey = findExistingItemByBaseName(state.items, name);
                    
                    if (existingKey) {
                        const existingItem = state.items[existingKey];
                        // Chỉ hợp nhất các trường thực tế tồn tại
                        const mergedItem = { ...existingItem };
                        if (newInfo.icon) mergedItem.icon = newInfo.icon;
                        // importance: Chỉ tăng không giảm (Rỗng < ! < !!)
                        mergedItem.importance = newInfo.importance || existingItem.importance || '';
                        if (newInfo.holder !== undefined) mergedItem.holder = newInfo.holder;
                        if (newInfo.location !== undefined) mergedItem.location = newInfo.location;
                        // Mô tả không rỗng mới ghi đè
                        if (newInfo.description !== undefined && newInfo.description.trim()) {
                            mergedItem.description = newInfo.description;
                        }
                        if (!mergedItem.description) mergedItem.description = existingItem.description || '';
                        
                        if (existingKey !== name) {
                            delete state.items[existingKey];
                            console.log(`[Horae] Cập nhật số lượng vật phẩm: ${existingKey} → ${name}`);
                        }
                        state.items[name] = mergedItem;
                    } else {
                        state.items[name] = newInfo;
                    }
                }
            }
            
            // Xử lý vật phẩm đã xóa
            if (meta.deletedItems && meta.deletedItems.length > 0) {
                for (const deletedItem of meta.deletedItems) {
                    const deleteBase = getItemBaseName(deletedItem).toLowerCase();
                    for (const itemName of Object.keys(state.items)) {
                        const itemBase = getItemBaseName(itemName).toLowerCase();
                        if (itemName.toLowerCase() === deletedItem.toLowerCase() ||
                            itemBase === deleteBase) {
                            delete state.items[itemName];
                            console.log(`[Horae] Vật phẩm đã xóa: ${itemName}`);
                        }
                    }
                }
            }
            
            // Hảo cảm: Hỗ trợ giá trị tuyệt đối và tương đối
            if (meta.affection) {
                for (const [key, value] of Object.entries(meta.affection)) {
                    if (typeof value === 'object' && value !== null) {
                        // Định dạng mới: {type: 'absolute'|'relative', value: number|string}
                        if (value.type === 'absolute') {
                            state.affection[key] = value.value;
                        } else if (value.type === 'relative') {
                            const delta = parseInt(value.value) || 0;
                            state.affection[key] = (state.affection[key] || 0) + delta;
                        }
                    } else {
                        // Tương thích định dạng cũ
                        const numValue = typeof value === 'number' ? value : parseInt(value) || 0;
                        state.affection[key] = (state.affection[key] || 0) + numValue;
                    }
                }
            }
            
            // NPC: Hợp nhất từng trường, giữ lại _id
            if (meta.npcs) {
                // Các trường có thể cập nhật vs Các trường được bảo vệ
                const updatableFields = ['appearance', 'personality', 'relationship', 'age', 'job', 'note'];
                const protectedFields = ['gender', 'race']; // Giới tính/Chủng tộc rất ít khi thay đổi
                for (const [name, newNpc] of Object.entries(meta.npcs)) {
                    const existing = state.npcs[name];
                    if (existing) {
                        for (const field of updatableFields) {
                            if (newNpc[field] !== undefined) existing[field] = newNpc[field];
                        }
                        // Khi tuổi thay đổi, ghi lại ngày cốt truyện làm mốc
                        if (newNpc.age !== undefined && newNpc.age !== '') {
                            if (!existing._ageRefDate) {
                                existing._ageRefDate = state.timestamp.story_date || '';
                            }
                            const oldAgeNum = parseInt(existing.age);
                            const newAgeNum = parseInt(newNpc.age);
                            if (!isNaN(oldAgeNum) && !isNaN(newAgeNum) && oldAgeNum !== newAgeNum) {
                                existing._ageRefDate = state.timestamp.story_date || '';
                            }
                        }
                        // Trường được bảo vệ: Chỉ điền khi chưa được thiết lập
                        for (const field of protectedFields) {
                            if (newNpc[field] !== undefined && !existing[field]) {
                                existing[field] = newNpc[field];
                            }
                        }
                        if (newNpc.last_seen) existing.last_seen = newNpc.last_seen;
                    } else {
                        state.npcs[name] = {
                            appearance: newNpc.appearance || '',
                            personality: newNpc.personality || '',
                            relationship: newNpc.relationship || '',
                            gender: newNpc.gender || '',
                            age: newNpc.age || '',
                            race: newNpc.race || '',
                            job: newNpc.job || '',
                            note: newNpc.note || '',
                            _ageRefDate: newNpc.age ? (state.timestamp.story_date || '') : '',
                            first_seen: newNpc.first_seen || new Date().toISOString(),
                            last_seen: newNpc.last_seen || new Date().toISOString()
                        };
                    }
                }
            }
        }
        
        // Cấp ID cho vật phẩm chưa có ID
        let maxId = 0;
        for (const info of Object.values(state.items)) {
            if (info._id) {
                const num = parseInt(info._id, 10);
                if (num > maxId) maxId = num;
            }
        }
        for (const info of Object.values(state.items)) {
            if (!info._id) {
                maxId++;
                info._id = padItemId(maxId);
            }
        }
        
        // Cấp ID cho NPC chưa có ID
        let maxNpcId = 0;
        for (const info of Object.values(state.npcs)) {
            if (info._id) {
                const num = parseInt(info._id, 10);
                if (num > maxNpcId) maxNpcId = num;
            }
        }
        for (const info of Object.values(state.npcs)) {
            if (!info._id) {
                maxNpcId++;
                info._id = padItemId(maxNpcId);
            }
        }
        
        return state;
    }

    /** Tính tuổi hiện tại của NPC dựa trên sự trôi qua của thời gian cốt truyện */
    calcCurrentAge(npcInfo, currentStoryDate) {
        const original = npcInfo.age || '';
        const refDate = npcInfo._ageRefDate || '';
        
        // Trường hợp không thể tính toán: không có tuổi, không có ngày tham chiếu, không có ngày hiện tại
        if (!original || !refDate || !currentStoryDate) {
            return { display: original, original, changed: false };
        }
        
        const ageNum = parseInt(original);
        if (isNaN(ageNum)) {
            // Tuổi không phải số, không thể tính
            return { display: original, original, changed: false };
        }
        
        const refParsed = parseStoryDate(refDate);
        const curParsed = parseStoryDate(currentStoryDate);
        
        // Cần cả hai đều là loại standard và có năm mới tính được
        if (!refParsed || !curParsed || refParsed.type !== 'standard' || curParsed.type !== 'standard') {
            return { display: original, original, changed: false };
        }
        if (!refParsed.year || !curParsed.year) {
            return { display: original, original, changed: false };
        }
        
        let yearDiff = curParsed.year - refParsed.year;
        
        // Đánh giá ngày tháng để xem đã qua sinh nhật chưa (ước tính)
        if (refParsed.month && curParsed.month) {
            if (curParsed.month < refParsed.month || 
                (curParsed.month === refParsed.month && (curParsed.day || 1) < (refParsed.day || 1))) {
                yearDiff -= 1;
            }
        }
        
        if (yearDiff <= 0) {
            return { display: original, original, changed: false };
        }
        
        const currentAge = ageNum + yearDiff;
        return { 
            display: String(currentAge), 
            original, 
            changed: true 
        };
    }

    /** Tìm vật phẩm qua ID */
    findItemById(items, id) {
        const normalizedId = id.replace(/^#/, '').trim();
        for (const [name, info] of Object.entries(items)) {
            if (info._id === normalizedId || info._id === padItemId(parseInt(normalizedId, 10))) {
                return [name, info];
            }
        }
        return null;
    }

    /** Lấy danh sách sự kiện (dùng cho hiển thị dòng thời gian) */
    getEvents(limit = 50, filterLevel = 'all') {
        const chat = this.getChat();
        const events = [];
        
        for (let i = 0; i < chat.length && events.length < limit; i++) {
            const meta = chat[i].horae_meta;
            
            // Hỗ trợ định dạng mới (mảng events) và cũ (event đơn)
            const metaEvents = meta?.events || (meta?.event ? [meta.event] : []);
            
            for (let j = 0; j < metaEvents.length; j++) {
                const evt = metaEvents[j];
                if (!evt?.summary) continue;
                
                if (filterLevel !== 'all' && evt.level !== filterLevel) {
                    continue;
                }
                
                events.push({
                    messageIndex: i,
                    eventIndex: j,  // Chỉ mục sự kiện trong tin nhắn đó
                    timestamp: meta.timestamp,
                    event: evt
                });
                
                if (events.length >= limit) break;
            }
        }
        
        return events;
    }

    /** Lấy danh sách sự kiện quan trọng (tương thích gọi cũ) */
    getImportantEvents(limit = 50) {
        return this.getEvents(limit, 'all');
    }

    /** Tạo nội dung nhắc nhở (Prompt) gọn nhẹ */
    generateCompactPrompt() {
        const state = this.getLatestState();
        const lines = [];
        
        // Tiêu đề bản sao trạng thái
        lines.push('[Bản sao trạng thái hiện tại —— So sánh với cốt truyện vòng này, chỉ xuất các trường có thay đổi thực sự trong <horae>]');
        
        const sendTimeline = this.settings?.sendTimeline !== false;
        const sendCharacters = this.settings?.sendCharacters !== false;
        const sendItems = this.settings?.sendItems !== false;
        
        // Thời gian
        if (state.timestamp.story_date) {
            const fullDateTime = formatFullDateTime(state.timestamp.story_date, state.timestamp.story_time);
            lines.push(`[Thời gian|${fullDateTime}]`);
            
            // Tham chiếu thời gian
            if (sendTimeline) {
                const timeRef = generateTimeReference(state.timestamp.story_date);
                if (timeRef && timeRef.type === 'standard') {
                    // Lịch tiêu chuẩn
                    lines.push(`[Tham chiếu thời gian|Hôm qua=${timeRef.yesterday}|Hôm kia=${timeRef.dayBefore}|3 ngày trước=${timeRef.threeDaysAgo}]`);
                } else if (timeRef && timeRef.type === 'fantasy') {
                    // Lịch giả tưởng
                    lines.push(`[Tham chiếu thời gian|Chế độ lịch giả tưởng, xem dấu thời gian tương đối trong quỹ đạo cốt truyện]`);
                }
            }
        }
        
        // Bối cảnh
        if (state.scene.location) {
            let sceneStr = `[Bối cảnh|${state.scene.location}`;
            if (state.scene.atmosphere) {
                sceneStr += `|${state.scene.atmosphere}`;
            }
            sceneStr += ']';
            lines.push(sceneStr);
        }
        
        // Nhân vật có mặt và trang phục
        if (sendCharacters) {
            const presentChars = state.scene.characters_present || [];
            
            if (presentChars.length > 0) {
                const charStrs = [];
                for (const char of presentChars) {
                    // Khớp mờ trang phục
                    const costumeKey = Object.keys(state.costumes || {}).find(
                        k => k === char || k.includes(char) || char.includes(k)
                    );
                    if (costumeKey && state.costumes[costumeKey]) {
                        charStrs.push(`${char}(${state.costumes[costumeKey]})`);
                    } else {
                        charStrs.push(char);
                    }
                }
                lines.push(`[Có mặt|${charStrs.join('|')}]`);
            }
        }
        
        // Vật phẩm
        if (sendItems) {
            const items = Object.entries(state.items);
            if (items.length > 0) {
                lines.push('\n[Danh sách vật phẩm]');
                for (const [name, info] of items) {
                    const id = info._id || '???';
                    const icon = info.icon || '';
                    const imp = info.importance === '!!' ? 'Then chốt' : info.importance === '!' ? 'Quan trọng' : '';
                    const desc = info.description ? ` | ${info.description}` : '';
                    const holder = info.holder || '';
                    const loc = info.location ? `@${info.location}` : '';
                    const impTag = imp ? `[${imp}]` : '';
                    lines.push(`#${id} ${icon}${name}${impTag}${desc} = ${holder}${loc}`);
                }
            } else {
                lines.push('\n[Danh sách vật phẩm] (Trống)');
            }
        }
        
        // Hảo cảm
        if (sendCharacters) {
            const affections = Object.entries(state.affection).filter(([_, v]) => v !== 0);
            if (affections.length > 0) {
                const affStr = affections.map(([k, v]) => `${k}:${v > 0 ? '+' : ''}${v}`).join('|');
                lines.push(`[Hảo cảm|${affStr}]`);
            }
            
            // Thông tin NPC
            const npcs = Object.entries(state.npcs);
            if (npcs.length > 0) {
                lines.push('\n[NPC đã biết]');
                for (const [name, info] of npcs) {
                    const id = info._id || '?';
                    const app = info.appearance || '';
                    const per = info.personality || '';
                    const rel = info.relationship || '';
                    // Chủ thể: N(ID) Tên ｜ Ngoại hình=Tính cách@Quan hệ
                    let npcStr = `N${id} ${name}`;
                    if (app || per || rel) {
                        npcStr += `｜${app}=${per}@${rel}`;
                    }
                    // Trường mở rộng
                    const extras = [];
                    if (info.gender) extras.push(`Giới tính:${info.gender}`);
                    if (info.age) {
                        const ageResult = this.calcCurrentAge(info, state.timestamp.story_date);
                        extras.push(`Tuổi:${ageResult.display}`);
                    }
                    if (info.race) extras.push(`Chủng tộc:${info.race}`);
                    if (info.job) extras.push(`Nghề nghiệp:${info.job}`);
                    if (info.note) extras.push(`Bổ sung:${info.note}`);
                    if (extras.length > 0) npcStr += `~${extras.join('~')}`;
                    lines.push(npcStr);
                }
            }
        }
        
        // Việc cần làm
        const chatForAgenda = this.getChat();
        const allAgendaItems = [];
        const seenTexts = new Set();
        const userAgenda = chatForAgenda?.[0]?.horae_meta?.agenda || [];
        for (const item of userAgenda) {
            if (!seenTexts.has(item.text)) {
                allAgendaItems.push(item);
                seenTexts.add(item.text);
            }
        }
        // AI ghi
        if (chatForAgenda) {
            for (let i = 1; i < chatForAgenda.length; i++) {
                const msgAgenda = chatForAgenda[i].horae_meta?.agenda;
                if (msgAgenda?.length > 0) {
                    for (const item of msgAgenda) {
                        if (!seenTexts.has(item.text)) {
                            allAgendaItems.push(item);
                            seenTexts.add(item.text);
                        }
                    }
                }
            }
        }
        const activeAgenda = allAgendaItems.filter(a => !a.done);
        if (activeAgenda.length > 0) {
            lines.push('\n[Việc cần làm]');
            for (const item of activeAgenda) {
                const datePrefix = item.date ? `${item.date} ` : '';
                lines.push(`· ${datePrefix}${item.text}`);
            }
        }
        
        // Quỹ đạo cốt truyện
        if (sendTimeline) {
            const events = this.getEvents(100, 'all');  // Lấy nhiều sự kiện hơn
            if (events.length > 0) {
                lines.push('\n[Quỹ đạo cốt truyện]');
                
                const currentDate = state.timestamp?.story_date || '';
                
                const getLevelMark = (level) => {
                    if (level === '关键' || level === 'Then chốt') return '★';
                    if (level === '重要' || level === 'Quan trọng') return '●';
                    return '○';
                };
                
                const getRelativeDesc = (eventDate) => {
                    if (!eventDate || !currentDate) return '';
                    const result = calculateDetailedRelativeTime(eventDate, currentDate);
                    if (result.days === null || result.days === undefined) return '';
                    
                    const { days, fromDate, toDate } = result;
                    
                    if (days === 0) return '(Hôm nay)';
                    if (days === 1) return '(Hôm qua)';
                    if (days === 2) return '(Hôm kia)';
                    if (days === 3) return '(Hôm kìa)';
                    if (days === -1) return '(Ngày mai)';
                    if (days === -2) return '(Ngày kia)';
                    if (days === -3) return '(Ngày kìa)';
                    
                    // Tuần trước thứ mấy (4-13 ngày trước và có thông tin ngày)
                    if (days >= 4 && days <= 13 && fromDate) {
                        const WEEKDAY_NAMES = ['Chủ Nhật', 'Hai', 'Ba', 'Tư', 'Năm', 'Sáu', 'Bảy'];
                        const weekday = fromDate.getDay();
                        return `(Thứ ${WEEKDAY_NAMES[weekday]} tuần trước)`;
                    }
                    
                    // Tháng trước
                    if (days >= 20 && days < 60 && fromDate && toDate) {
                        const fromMonth = fromDate.getMonth();
                        const toMonth = toDate.getMonth();
                        if (fromMonth !== toMonth) {
                            return `(Ngày ${fromDate.getDate()} tháng trước)`;
                        }
                    }
                    
                    // Năm ngoái
                    if (days >= 300 && fromDate && toDate) {
                        const fromYear = fromDate.getFullYear();
                        const toYear = toDate.getFullYear();
                        if (fromYear < toYear) {
                            const fromMonth = fromDate.getMonth() + 1;
                            return `(Tháng ${fromMonth} năm ngoái)`;
                        }
                    }
                    
                    // Định dạng chung
                    if (days > 0 && days < 30) return `(${days} ngày trước)`;
                    if (days > 0) return `(${Math.round(days / 30)} tháng trước)`;
                    if (days === -999 || days === -998 || days === -997) return '';
                    return '';
                };
                
                // Sắp xếp theo thứ tự tin nhắn
                const sortedEvents = [...events].sort((a, b) => {
                    return (a.messageIndex || 0) - (b.messageIndex || 0);
                });
                
                // Lọc: Lấy tất cả Then chốt/Quan trọng + 30 sự kiện Bình thường gần nhất
                const criticalAndImportant = sortedEvents.filter(e => 
                    e.event?.level === '关键' || e.event?.level === 'Then chốt' || e.event?.level === '重要' || e.event?.level === 'Quan trọng'
                );
                const normalEvents = sortedEvents.filter(e => 
                    e.event?.level === '一般' || e.event?.level === 'Bình thường' || !e.event?.level
                ).slice(-30);  // Chỉ lấy 30 sự kiện bình thường gần nhất
                
                // Hợp nhất và sắp xếp lại
                const allToShow = [...criticalAndImportant, ...normalEvents]
                    .sort((a, b) => (a.messageIndex || 0) - (b.messageIndex || 0));
                
                for (const e of allToShow) {
                    const mark = getLevelMark(e.event?.level);
                    const date = e.timestamp?.story_date || '?';
                    const time = e.timestamp?.story_time || '';
                    const timeStr = time ? `${date} ${time}` : date;
                    const relativeDesc = getRelativeDesc(e.timestamp?.story_date);
                    const msgNum = e.messageIndex !== undefined ? `#${e.messageIndex}` : '';
                    lines.push(`${mark} ${msgNum} ${timeStr}${relativeDesc}: ${e.event.summary}`);
                }
            }
        }
        
        // Dữ liệu bảng tùy chỉnh
        const chat = this.getChat();
        const firstMsg = chat?.[0];
        const customTables = firstMsg?.horae_meta?.customTables || this.settings?.customTables || [];
        for (const table of customTables) {
            const rows = table.rows || 2;
            const cols = table.cols || 2;
            const data = table.data || {};
            
            // Chỉ xuất khi có nội dung hoặc có hướng dẫn điền
            const hasContent = Object.values(data).some(v => v && v.trim());
            const hasPrompt = table.prompt && table.prompt.trim();
            if (!hasContent && !hasPrompt) continue;
            
            const tableName = table.name || 'Bảng tùy chỉnh';
            lines.push(`\n[${tableName}]`);
            
            if (table.prompt && table.prompt.trim()) {
                lines.push(`(Yêu cầu điền: ${table.prompt.trim()})`);
            }
            
            // Hiển thị thông minh: Ẩn cột trống và hàng trống ở cuối
            // 1. Phát hiện cột có dữ liệu
            const activeCols = [0]; // col 0 = tiêu đề hàng, luôn hiển thị
            const emptyCols = [];   // Cột hoàn toàn trống
            for (let c = 1; c < cols; c++) {
                let colHasData = false;
                for (let r = 1; r < rows; r++) {
                    if (data[`${r}-${c}`] && data[`${r}-${c}`].trim()) {
                        colHasData = true;
                        break;
                    }
                }
                if (colHasData) {
                    activeCols.push(c);
                } else {
                    emptyCols.push(c);
                }
            }
            
            // 2. Phát hiện hàng cuối cùng có dữ liệu
            let lastDataRow = 0;
            for (let r = rows - 1; r >= 1; r--) {
                for (let c = 1; c < cols; c++) {
                    if (data[`${r}-${c}`] && data[`${r}-${c}`].trim()) {
                        lastDataRow = r;
                        break;
                    }
                }
                if (lastDataRow > 0) break;
            }
            // Ít nhất hiển thị hàng 1
            if (lastDataRow === 0) lastDataRow = 1;
            
            // 3. Xuất hàng tiêu đề
            const headerRow = activeCols.map(c => data[`0-${c}`] || (c === 0 ? 'Tiêu đề' : `Cột ${c}`));
            lines.push(headerRow.join(' | '));
            
            // 4. Xuất các hàng dữ liệu
            for (let r = 1; r <= lastDataRow; r++) {
                const rowData = activeCols.map(c => {
                    if (c === 0) return data[`${r}-0`] || `${r}`;
                    return data[`${r}-${c}`] || '-';
                });
                lines.push(rowData.join(' | '));
            }
            
            // 5. Chú thích các hàng trống ở cuối bị lược bỏ
            if (lastDataRow < rows - 1) {
                lines.push(`(Tổng ${rows - 1} hàng, hàng ${lastDataRow + 1}-${rows - 1} tạm chưa có dữ liệu)`);
            }
            
            // 6. Nhắc nhở về các cột trống
            if (emptyCols.length > 0) {
                const emptyColNames = emptyCols.map(c => data[`0-${c}`] || `Cột ${c}`);
                lines.push(`(${emptyColNames.join('、')}：Tạm chưa có dữ liệu, cấm điền khi sự kiện tương ứng chưa xảy ra)`);
            }
        }
        
        return lines.join('\n');
    }

    /** Lấy mô tả cấp độ hảo cảm */
    getAffectionLevel(value) {
        if (value >= 80) return 'Tri kỷ';
        if (value >= 60) return 'Thân mật';
        if (value >= 40) return 'Hảo cảm';
        if (value >= 20) return 'Hữu hảo';
        if (value >= 0) return 'Trung lập';
        if (value >= -20) return 'Lạnh nhạt';
        if (value >= -40) return 'Chán ghét';
        if (value >= -60) return 'Thù địch';
        return 'Căm thù';
    }

    /** Phân tích thẻ horae trong phản hồi của AI */
    parseHoraeTag(message) {
        if (!message) return null;
        
        let match = message.match(/<horae>([\s\S]*?)<\/horae>/i);
        if (!match) {
            match = message.match(//i);
        }
        
        const eventMatch = message.match(/<horaeevent>([\s\S]*?)<\/horaeevent>/i);
        const tableMatches = [...message.matchAll(/<horaetable[:：]\s*(.+?)>([\s\S]*?)<\/horaetable>/gi)];
        
        if (!match && !eventMatch && tableMatches.length === 0) return null;
        
        const content = match ? match[1].trim() : '';
        const eventContent = eventMatch ? eventMatch[1].trim() : '';
        const lines = content.split('\n').concat(eventContent.split('\n'));
        
        const result = {
            timestamp: {},
            costumes: {},
            items: {},
            deletedItems: [],
            events: [],  // Hỗ trợ nhiều sự kiện
            affection: {},
            npcs: {},
            scene: {},
            agenda: [],
            deletedAgenda: []
        };
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            
            // time:10/1 15:00 hoặc time:Lịch giả tưởng năm 2931 2/1(Sáu) 20:30
            if (trimmedLine.startsWith('time:')) {
                const timeStr = trimmedLine.substring(5).trim();
                // Tách giờ HH:MM từ cuối chuỗi
                const clockMatch = timeStr.match(/\b(\d{1,2}:\d{2})\s*$/);
                if (clockMatch) {
                    result.timestamp.story_time = clockMatch[1];
                    result.timestamp.story_date = timeStr.substring(0, timeStr.lastIndexOf(clockMatch[1])).trim();
                } else {
                    // Không có giờ, toàn bộ chuỗi là ngày
                    result.timestamp.story_date = timeStr;
                    result.timestamp.story_time = '';
                }
            }
            // location:Tầng 2 quán cà phê
            else if (trimmedLine.startsWith('location:')) {
                result.scene.location = trimmedLine.substring(9).trim();
            }
            // atmosphere:Thư giãn
            else if (trimmedLine.startsWith('atmosphere:')) {
                result.scene.atmosphere = trimmedLine.substring(11).trim();
            }
            // characters:Alice,Bob
            else if (trimmedLine.startsWith('characters:')) {
                const chars = trimmedLine.substring(11).trim();
                result.scene.characters_present = chars.split(/[,，]/).map(c => c.trim()).filter(Boolean);
            }
            // costume:Alice=Váy liền thân màu trắng
            else if (trimmedLine.startsWith('costume:')) {
                const costumeStr = trimmedLine.substring(8).trim();
                const eqIndex = costumeStr.indexOf('=');
                if (eqIndex > 0) {
                    const char = costumeStr.substring(0, eqIndex).trim();
                    const costume = costumeStr.substring(eqIndex + 1).trim();
                    result.costumes[char] = costume;
                }
            }
            // item-:Tên vật phẩm biểu thị vật phẩm đã tiêu hao/xóa
            else if (trimmedLine.startsWith('item-:')) {
                const itemName = trimmedLine.substring(6).trim();
                const cleanName = itemName.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, '').trim();
                if (cleanName) {
                    result.deletedItems.push(cleanName);
                }
            }
            // item:🍺Bia|Mô tả=Chủ quán@Quầy bar / item!:📜Vật phẩm quan trọng|Mô tả chức năng=Nhân vật@Vị trí / item!!:💎Vật phẩm then chốt=@Vị trí
            else if (trimmedLine.startsWith('item!!:') || trimmedLine.startsWith('item!:') || trimmedLine.startsWith('item:')) {
                let importance = '';  // Bình thường dùng chuỗi rỗng
                let itemStr;
                if (trimmedLine.startsWith('item!!:')) {
                    importance = '!!';  // Then chốt
                    itemStr = trimmedLine.substring(7).trim();
                } else if (trimmedLine.startsWith('item!:')) {
                    importance = '!';   // Quan trọng
                    itemStr = trimmedLine.substring(6).trim();
                } else {
                    itemStr = trimmedLine.substring(5).trim();
                }
                
                const eqIndex = itemStr.indexOf('=');
                if (eqIndex > 0) {
                    let itemNamePart = itemStr.substring(0, eqIndex).trim();
                    const rest = itemStr.substring(eqIndex + 1).trim();
                    
                    let icon = null;
                    let itemName = itemNamePart;
                    let description = undefined;  // undefined = không có trường mô tả, khi hợp nhất sẽ không ghi đè mô tả cũ
                    
                    const emojiMatch = itemNamePart.match(/^([\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]|[\u{231A}-\u{231B}]|[\u{23E9}-\u{23F3}]|[\u{23F8}-\u{23FA}]|[\u{25AA}-\u{25AB}]|[\u{25B6}]|[\u{25C0}]|[\u{25FB}-\u{25FE}]|[\u{2614}-\u{2615}]|[\u{2648}-\u{2653}]|[\u{267F}]|[\u{2693}]|[\u{26A1}]|[\u{26AA}-\u{26AB}]|[\u{26BD}-\u{26BE}]|[\u{26C4}-\u{26C5}]|[\u{26CE}]|[\u{26D4}]|[\u{26EA}]|[\u{26F2}-\u{26F3}]|[\u{26F5}]|[\u{26FA}]|[\u{26FD}]|[\u{2702}]|[\u{2705}]|[\u{2708}-\u{270D}]|[\u{270F}]|[\u{2712}]|[\u{2714}]|[\u{2716}]|[\u{271D}]|[\u{2721}]|[\u{2728}]|[\u{2733}-\u{2734}]|[\u{2744}]|[\u{2747}]|[\u{274C}]|[\u{274E}]|[\u{2753}-\u{2755}]|[\u{2757}]|[\u{2763}-\u{2764}]|[\u{2795}-\u{2797}]|[\u{27A1}]|[\u{27B0}]|[\u{27BF}]|[\u{2934}-\u{2935}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{2B50}]|[\u{2B55}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}])/u);
                    if (emojiMatch) {
                        icon = emojiMatch[1];
                        itemNamePart = itemNamePart.substring(icon.length).trim();
                    }
                    
                    const pipeIndex = itemNamePart.indexOf('|');
                    if (pipeIndex > 0) {
                        itemName = itemNamePart.substring(0, pipeIndex).trim();
                        const descText = itemNamePart.substring(pipeIndex + 1).trim();
                        if (descText) description = descText;
                    } else {
                        itemName = itemNamePart;
                    }
                    
                    // Loại bỏ dấu lượng từ vô nghĩa
                    itemName = itemName.replace(/[\(（]1[\)）]$/, '').trim();
                    itemName = itemName.replace(new RegExp(`[\\(（]1[${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                    itemName = itemName.replace(new RegExp(`[\\(（][${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                    
                    const atIndex = rest.indexOf('@');
                    const itemInfo = {
                        icon: icon,
                        importance: importance,
                        holder: atIndex >= 0 ? (rest.substring(0, atIndex).trim() || null) : (rest || null),
                        location: atIndex >= 0 ? (rest.substring(atIndex + 1).trim() || '') : ''
                    };
                    if (description !== undefined) itemInfo.description = description;
                    result.items[itemName] = itemInfo;
                }
            }
            // event:Quan trọng|Alice đã tiết lộ bí mật
            else if (trimmedLine.startsWith('event:')) {
                const eventStr = trimmedLine.substring(6).trim();
                const parts = eventStr.split('|');
                if (parts.length >= 2) {
                    const levelRaw = parts[0].trim();
                    const summary = parts.slice(1).join('|').trim();
                    
                    let level = '一般';
                    if (levelRaw === '关键' || levelRaw === 'Then chốt' || levelRaw.toLowerCase() === 'critical') {
                        level = '关键';
                    } else if (levelRaw === '重要' || levelRaw === 'Quan trọng' || levelRaw.toLowerCase() === 'important') {
                        level = '重要';
                    }
                    
                    result.events.push({
                        is_important: level === '重要' || level === '关键',
                        level: level,
                        summary: summary
                    });
                }
            }
            // affection:Bob=65 hoặc affection:Bob+5 (tương thích cũ/mới)
            // Chấp nhận AI thêm chú thích ví dụ affection:Tom=18(+0)|Quan sát thấy xxx, chỉ lấy tên và số
            else if (trimmedLine.startsWith('affection:')) {
                const affStr = trimmedLine.substring(10).trim();
                // Định dạng mới: Tên nhân vật=Giá trị (Tuyệt đối, cho phép dấu +/- ví dụ =+28 hoặc =-15)
                const absoluteMatch = affStr.match(/^(.+?)=\s*([+\-]?\d+)/);
                if (absoluteMatch) {
                    const key = absoluteMatch[1].trim();
                    const value = parseInt(absoluteMatch[2]);
                    result.affection[key] = { type: 'absolute', value: value };
                } else {
                    // Định dạng cũ: Tên nhân vật+/-Giá trị (Tương đối, không có dấu =) — Cho phép số theo sau là bất kỳ chú thích nào
                    const relativeMatch = affStr.match(/^(.+?)([+\-]\d+)/);
                    if (relativeMatch) {
                        const key = relativeMatch[1].trim();
                        const value = relativeMatch[2];
                        result.affection[key] = { type: 'relative', value: value };
                    }
                }
            }
            // npc:Tên|Ngoại hình=Tính cách@Quan hệ~Giới tính:Nam~Tuổi:25~Chủng tộc:Nhân loại~Nghề nghiệp:Lính đánh thuê~Bổ sung:xxx
            // Sử dụng ~ phân cách trường mở rộng (key:value), không phụ thuộc thứ tự
            else if (trimmedLine.startsWith('npc:')) {
                const npcStr = trimmedLine.substring(4).trim();
                const npcInfo = this._parseNpcFields(npcStr);
                const name = npcInfo._name;
                delete npcInfo._name;
                
                if (name) {
                    npcInfo.last_seen = new Date().toISOString();
                    if (!result.npcs[name]) {
                        npcInfo.first_seen = new Date().toISOString();
                    }
                    result.npcs[name] = npcInfo;
                }
            }
            // agenda-:Nội dung việc cần làm đã hoàn thành / agenda:Ngày thiết lập|Nội dung
            else if (trimmedLine.startsWith('agenda-:')) {
                const delStr = trimmedLine.substring(8).trim();
                if (delStr) {
                    const pipeIdx = delStr.indexOf('|');
                    const text = pipeIdx > 0 ? delStr.substring(pipeIdx + 1).trim() : delStr;
                    if (text) {
                        result.deletedAgenda.push(text);
                    }
                }
            }
            else if (trimmedLine.startsWith('agenda:')) {
                const agendaStr = trimmedLine.substring(7).trim();
                const pipeIdx = agendaStr.indexOf('|');
                if (pipeIdx > 0) {
                    const dateStr = agendaStr.substring(0, pipeIdx).trim();
                    const text = agendaStr.substring(pipeIdx + 1).trim();
                    if (text) {
                        result.agenda.push({ date: dateStr, text, source: 'ai', done: false });
                    }
                } else if (agendaStr) {
                    // Chấp nhận lỗi: Không có dấu phân cách ngày
                    result.agenda.push({ date: '', text: agendaStr, source: 'ai', done: false });
                }
            }
        }

        // Phân tích dữ liệu bảng tùy chỉnh
        if (tableMatches.length > 0) {
            result.tableUpdates = [];
            for (const tm of tableMatches) {
                const tableName = tm[1].trim();
                const tableContent = tm[2].trim();
                const updates = this._parseTableCellEntries(tableContent);
                
                if (Object.keys(updates).length > 0) {
                    result.tableUpdates.push({ name: tableName, updates });
                }
            }
        }

        return result;
    }

    /** Hợp nhất kết quả phân tích vào meta */
    mergeParsedToMeta(baseMeta, parsed) {
        const meta = baseMeta ? JSON.parse(JSON.stringify(baseMeta)) : createEmptyMeta();
        
        if (parsed.timestamp?.story_date) {
            meta.timestamp.story_date = parsed.timestamp.story_date;
        }
        if (parsed.timestamp?.story_time) {
            meta.timestamp.story_time = parsed.timestamp.story_time;
        }
        meta.timestamp.absolute = new Date().toISOString();
        
        if (parsed.scene?.location) {
            meta.scene.location = parsed.scene.location;
        }
        if (parsed.scene?.atmosphere) {
            meta.scene.atmosphere = parsed.scene.atmosphere;
        }
        if (parsed.scene?.characters_present?.length > 0) {
            meta.scene.characters_present = parsed.scene.characters_present;
        }
        
        if (parsed.costumes) {
            Object.assign(meta.costumes, parsed.costumes);
        }
        
        if (parsed.items) {
            Object.assign(meta.items, parsed.items);
        }
        
        if (parsed.deletedItems && parsed.deletedItems.length > 0) {
            if (!meta.deletedItems) meta.deletedItems = [];
            meta.deletedItems = [...new Set([...meta.deletedItems, ...parsed.deletedItems])];
        }
        
        // Hỗ trợ định dạng mới (mảng events) và cũ (event đơn)
        if (parsed.events && parsed.events.length > 0) {
            meta.events = parsed.events;
        } else if (parsed.event) {
            // Tương thích cũ: Chuyển thành mảng
            meta.events = [parsed.event];
        }
        
        if (parsed.affection) {
            Object.assign(meta.affection, parsed.affection);
        }
        
        if (parsed.npcs) {
            Object.assign(meta.npcs, parsed.npcs);
        }
        
        // Thêm việc cần làm do AI ghi
        if (parsed.agenda && parsed.agenda.length > 0) {
            if (!meta.agenda) meta.agenda = [];
            for (const item of parsed.agenda) {
                // Khử trùng lặp
                const isDupe = meta.agenda.some(a => a.text === item.text);
                if (!isDupe) {
                    meta.agenda.push(item);
                }
            }
        }
        
        // tableUpdates truyền như thuộc tính phụ
        if (parsed.tableUpdates) {
            meta._tableUpdates = parsed.tableUpdates;
        }
        
        return meta;
    }

    /** Xóa toàn cục các việc cần làm đã hoàn thành */
    removeCompletedAgenda(deletedTexts) {
        const chat = this.getChat();
        if (!chat || deletedTexts.length === 0) return;

        const isMatch = (agendaText, deleteText) => {
            if (!agendaText || !deleteText) return false;
            // Khớp chính xác hoặc chứa nhau (Cho phép AI viết tắt/mở rộng)
            return agendaText === deleteText ||
                   agendaText.includes(deleteText) ||
                   deleteText.includes(agendaText);
        };

        if (chat[0]?.horae_meta?.agenda) {
            chat[0].horae_meta.agenda = chat[0].horae_meta.agenda.filter(
                a => !deletedTexts.some(dt => isMatch(a.text, dt))
            );
        }

        for (let i = 1; i < chat.length; i++) {
            if (chat[i]?.horae_meta?.agenda?.length > 0) {
                chat[i].horae_meta.agenda = chat[i].horae_meta.agenda.filter(
                    a => !deletedTexts.some(dt => isMatch(a.text, dt))
                );
            }
        }
    }

    /** Xử lý phản hồi AI, phân tích thẻ và lưu trữ meta */
    processAIResponse(messageIndex, messageContent) {
        const parsed = this.parseHoraeTag(messageContent);
        
        if (parsed) {
            const existingMeta = this.getMessageMeta(messageIndex);
            const newMeta = this.mergeParsedToMeta(existingMeta, parsed);
            
            // Xử lý cập nhật bảng
            if (newMeta._tableUpdates) {
                // Ghi lại đóng góp bảng, dùng để hồi phục
                newMeta.tableContributions = newMeta._tableUpdates;
                this.applyTableUpdates(newMeta._tableUpdates);
                delete newMeta._tableUpdates;
            }
            
            // Xử lý việc cần làm đã hoàn thành do AI đánh dấu
            if (parsed.deletedAgenda && parsed.deletedAgenda.length > 0) {
                this.removeCompletedAgenda(parsed.deletedAgenda);
            }
            
            this.setMessageMeta(messageIndex, newMeta);
            return true;
        } else {
            // Không có thẻ, tạo meta rỗng
            if (!this.getMessageMeta(messageIndex)) {
                this.setMessageMeta(messageIndex, createEmptyMeta());
            }
            return false;
        }
    }

    /**
     * Phân tích các trường NPC
     * Định dạng: Tên|Ngoại hình=Tính cách@Quan hệ~Giới tính:Nam~Tuổi:25~Chủng tộc:Nhân loại~Nghề nghiệp:Lính đánh thuê~Bổ sung:xxx
     */
    _parseNpcFields(npcStr) {
        const info = {};
        if (!npcStr) return { _name: '' };
        
        // 1. Tách các trường mở rộng
        const tildeParts = npcStr.split('~');
        const mainPart = tildeParts[0].trim(); // Tên|Ngoại hình=Tính cách@Quan hệ
        
        for (let i = 1; i < tildeParts.length; i++) {
            const kv = tildeParts[i].trim();
            if (!kv) continue;
            const colonIdx = kv.indexOf(':');
            if (colonIdx <= 0) continue;
            const key = kv.substring(0, colonIdx).trim();
            const value = kv.substring(colonIdx + 1).trim();
            if (!value) continue;
            
            // Khớp từ khóa (Hỗ trợ tiếng Việt)
            if (/^(性别|gender|sex|Giới tính)$/i.test(key)) info.gender = value;
            else if (/^(年龄|age|年纪|Tuổi)$/i.test(key)) info.age = value;
            else if (/^(种族|race|族裔|族群|Chủng tộc)$/i.test(key)) info.race = value;
            else if (/^(职业|job|class|职务|身份|Nghề nghiệp)$/i.test(key)) info.job = value;
            else if (/^(补充|note|备注|其他|Bổ sung|Ghi chú)$/i.test(key)) info.note = value;
        }
        
        // 2. Phân tích phần chính
        let name = '';
        const pipeIdx = mainPart.indexOf('|');
        if (pipeIdx > 0) {
            name = mainPart.substring(0, pipeIdx).trim();
            const descPart = mainPart.substring(pipeIdx + 1).trim();
            
            const hasNewFormat = descPart.includes('=') || descPart.includes('@');
            
            if (hasNewFormat) {
                const atIdx = descPart.indexOf('@');
                let beforeAt = atIdx >= 0 ? descPart.substring(0, atIdx) : descPart;
                const relationship = atIdx >= 0 ? descPart.substring(atIdx + 1).trim() : '';
                
                const eqIdx = beforeAt.indexOf('=');
                const appearance = eqIdx >= 0 ? beforeAt.substring(0, eqIdx).trim() : beforeAt.trim();
                const personality = eqIdx >= 0 ? beforeAt.substring(eqIdx + 1).trim() : '';
                
                if (appearance) info.appearance = appearance;
                if (personality) info.personality = personality;
                if (relationship) info.relationship = relationship;
            } else {
                const parts = descPart.split('|').map(s => s.trim());
                if (parts[0]) info.appearance = parts[0];
                if (parts[1]) info.personality = parts[1];
                if (parts[2]) info.relationship = parts[2];
            }
        } else {
            name = mainPart.trim();
        }
        
        info._name = name;
        return info;
    }

    /**
     * Phân tích dữ liệu ô bảng
     * Định dạng: Mỗi dòng một ô 1,1:Nội dung hoặc Nhiều ô một dòng dùng | phân cách
     */
    _parseTableCellEntries(text) {
        const updates = {};
        if (!text) return updates;
        
        const cellRegex = /^(\d+)[,\-](\d+)[:：]\s*(.*)$/;
        
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            // Phân cách bằng |
            const segments = trimmed.split(/\s*[|｜]\s*/);
            
            for (const seg of segments) {
                const s = seg.trim();
                if (!s) continue;
                
                const m = s.match(cellRegex);
                if (m) {
                    const r = parseInt(m[1]);
                    const c = parseInt(m[2]);
                    const value = m[3].trim();
                    // Lọc các dấu hiệu rỗng
                    if (value && !/^[\(\（]?(空|Trống)[\)\）]?$/i.test(value) && !/^[-—]+$/.test(value)) {
                        updates[`${r}-${c}`] = value;
                    }
                }
            }
        }
        
        return updates;
    }

    /** Áp dụng cập nhật bảng vào chat[0] */
    applyTableUpdates(tableUpdates) {
        if (!tableUpdates || tableUpdates.length === 0) return;
        
        const chat = this.getChat();
        if (!chat || chat.length === 0) return;
        
        const firstMsg = chat[0];
        if (!firstMsg.horae_meta) firstMsg.horae_meta = createEmptyMeta();
        if (!firstMsg.horae_meta.customTables) firstMsg.horae_meta.customTables = [];
        
        const tables = firstMsg.horae_meta.customTables;
        
        for (const update of tableUpdates) {
            // Tìm bảng tương ứng
            const updateName = (update.name || '').trim();
            const table = tables.find(t => (t.name || '').trim() === updateName);
            if (!table) {
                console.warn(`[Horae] Bảng "${updateName}" không tồn tại (các bảng hiện có: ${tables.map(t => t.name).join(', ')}), bỏ qua`);
                continue;
            }
            
            if (!table.data) table.data = {};
            
            let updatedCount = 0;
            
            // Ghi vào ô, tự động mở rộng, bảo vệ tiêu đề
            for (const [key, value] of Object.entries(update.updates)) {
                const [r, c] = key.split('-').map(Number);
                
                // Bảo vệ tiêu đề
                if (r === 0 || c === 0) {
                    const existing = table.data[key];
                    if (existing && existing.trim()) {
                        console.log(`[Horae] Bảng "${updateName}" bỏ qua ô tiêu đề [${r},${c}] (đã có: "${existing}")`);
                        continue;
                    }
                }
                
                table.data[key] = value;
                updatedCount++;
                
                if (r + 1 > (table.rows || 2)) table.rows = r + 1;
                if (c + 1 > (table.cols || 2)) table.cols = c + 1;
            }
            
            console.log(`[Horae] Bảng "${updateName}" đã cập nhật ${updatedCount} ô`);
        }
    }

    /** Xây dựng lại dữ liệu bảng (sau khi xóa/sửa tin nhắn để đảm bảo nhất quán) */
    rebuildTableData() {
        const chat = this.getChat();
        if (!chat || chat.length === 0) return;
        
        const firstMsg = chat[0];
        if (!firstMsg.horae_meta?.customTables) return;
        
        const tables = firstMsg.horae_meta.customTables;
        
        // 1. Khôi phục về snapshot baseData
        for (const table of tables) {
            if (table.baseData) {
                table.data = JSON.parse(JSON.stringify(table.baseData));
            } else {
                // Không có baseData: Xóa vùng dữ liệu, giữ lại tiêu đề
                if (!table.data) { table.data = {}; continue; }
                const keysToDelete = [];
                for (const key of Object.keys(table.data)) {
                    const [r, c] = key.split('-').map(Number);
                    if (r >= 1 && c >= 1) keysToDelete.push(key);
                }
                for (const key of keysToDelete) delete table.data[key];
            }
            
            if (table.baseRows !== undefined) {
                table.rows = table.baseRows;
            } else if (table.baseData) {
                // Không có baseRows, tính từ baseData
                let calcRows = 2, calcCols = 2;
                for (const key of Object.keys(table.baseData)) {
                    const [r, c] = key.split('-').map(Number);
                    if (r === 0 && c + 1 > calcCols) calcCols = c + 1;
                    if (c === 0 && r + 1 > calcRows) calcRows = r + 1;
                }
                table.rows = calcRows;
                table.cols = calcCols;
            }
            if (table.baseCols !== undefined) {
                table.cols = table.baseCols;
            }
        }
        
        // 2. Phát lại tableContributions theo thứ tự tin nhắn
        let totalApplied = 0;
        for (let i = 0; i < chat.length; i++) {
            const meta = chat[i].horae_meta;
            if (meta?.tableContributions && meta.tableContributions.length > 0) {
                this.applyTableUpdates(meta.tableContributions);
                totalApplied++;
            }
        }
        
        console.log(`[Horae] Dữ liệu bảng đã được xây dựng lại, phát lại đóng góp bảng của ${totalApplied} tin nhắn`);
    }

    /** Quét và tiêm lịch sử */
    async scanAndInjectHistory(progressCallback, analyzeCallback = null) {
        const chat = this.getChat();
        let processed = 0;
        let skipped = 0;

        for (let i = 0; i < chat.length; i++) {
            const message = chat[i];
            
            if (message.is_user) {
                skipped++;
                if (progressCallback) {
                    progressCallback(Math.round((i + 1) / chat.length * 100), i + 1, chat.length);
                }
                continue;
            }

            // Bỏ qua nếu đã có meta
            const hasEvents = message.horae_meta?.events?.length > 0 || message.horae_meta?.event?.summary;
            if (message.horae_meta && (
                message.horae_meta.timestamp?.story_date ||
                hasEvents ||
                Object.keys(message.horae_meta.costumes || {}).length > 0
            )) {
                skipped++;
                if (progressCallback) {
                    progressCallback(Math.round((i + 1) / chat.length * 100), i + 1, chat.length);
                }
                continue;
            }

            const parsed = this.parseHoraeTag(message.mes);
            
            if (parsed) {
                const meta = this.mergeParsedToMeta(null, parsed);
                // Ghi lại đóng góp bảng
                if (meta._tableUpdates) {
                    meta.tableContributions = meta._tableUpdates;
                    delete meta._tableUpdates;
                }
                this.setMessageMeta(i, meta);
                processed++;
            } else if (analyzeCallback) {
                try {
                    const analyzed = await analyzeCallback(message.mes);
                    if (analyzed) {
                        const meta = this.mergeParsedToMeta(null, analyzed);
                        if (meta._tableUpdates) {
                            meta.tableContributions = meta._tableUpdates;
                            delete meta._tableUpdates;
                        }
                        this.setMessageMeta(i, meta);
                        processed++;
                    }
                } catch (error) {
                    console.error(`[Horae] Phân tích tin nhắn #${i} thất bại:`, error);
                }
            } else {
                const meta = createEmptyMeta();
                this.setMessageMeta(i, meta);
                processed++;
            }

            if (progressCallback) {
                progressCallback(Math.round((i + 1) / chat.length * 100), i + 1, chat.length);
            }
        }

        return { processed, skipped };
    }

    /** Tạo nội dung bổ sung cho System Prompt */
    generateSystemPromptAddition() {
        const userName = this.context?.name1 || 'Nhân vật chính';
        const charName = this.context?.name2 || 'Nhân vật';
        
        return `
【Hệ thống Ký ức Horae】(Các ví dụ dưới đây chỉ là mẫu, không sử dụng nguyên văn vào chính văn!)

═══ Nguyên tắc cốt lõi: Điều khiển bởi sự thay đổi ═══
★★★ Trước khi viết thẻ <horae>, hãy phán đoán xem thông tin nào đã THỰC SỰ THAY ĐỔI trong vòng này ★★★
  ① Cơ sở bối cảnh (time/location/characters/costume) → Bắt buộc điền mỗi vòng
  ② Tất cả các trường khác → Tuân thủ nghiêm ngặt [Điều kiện kích hoạt] của từng trường, không thay đổi thì tuyệt đối không viết dòng đó
  ③ NPC/Vật phẩm đã ghi nếu không có thông tin mới → Cấm xuất ra! Xuất lại dữ liệu không đổi = lãng phí token
  ④ Một phần trường thay đổi → Sử dụng cập nhật gia tăng, chỉ viết phần thay đổi

═══ Định dạng thẻ ═══
Viết hai thẻ này ở cuối mỗi phản hồi:
<horae>
time:Ngày Giờ (Bắt buộc)
location:Địa điểm (Bắt buộc)
atmosphere:Bầu không khí
characters:Tên nhân vật có mặt, phân cách bằng dấu phẩy (Bắt buộc)
costume:Tên nhân vật=Mô tả trang phục (Bắt buộc, mỗi người một dòng, cấm gộp bằng dấu chấm phẩy)
item/item!/item!!:Xem quy tắc vật phẩm (Chỉ viết khi được kích hoạt)
item-:Tên vật phẩm (Xóa khi vật phẩm bị tiêu hao/mất. Xem quy tắc vật phẩm, chỉ viết khi được kích hoạt)
affection:Tên nhân vật=Hảo cảm (Chỉ viết khi được kích hoạt)
npc:Tên nhân vật|Ngoại hình=Tính cách@Quan hệ~Trường mở rộng (Chỉ viết khi được kích hoạt)
agenda:Ngày|Nội dung (Chỉ viết khi kích hoạt việc cần làm mới)
agenda-:Từ khóa nội dung (Chỉ viết khi việc cần làm đã hoàn thành/hết hiệu lực, hệ thống tự động xóa việc cần làm khớp)
</horae>
<horaeevent>
event:Mức độ quan trọng|Tóm tắt sự kiện (30-50 từ, mức độ: Bình thường/Quan trọng/Then chốt, ghi lại tóm tắt sự kiện để truy xuất cốt truyện)
</horaeevent>

═══ Quy tắc & Điều kiện kích hoạt [Vật phẩm] ═══
Tham chiếu số thứ tự (#ID) trong [Danh sách vật phẩm], tuân thủ nghiêm ngặt các điều kiện sau để quyết định có xuất hay không.

【Khi nào viết】(Chỉ xuất khi thỏa mãn bất kỳ điều kiện nào)
  ✦ Nhận vật phẩm mới → item:/item!:/item!!:
  ✦ Số lượng/Quyền sở hữu/Vị trí/Tính chất của vật phẩm đã có thay đổi → item: (Chỉ viết phần thay đổi)
  ✦ Vật phẩm tiêu hao/mất/dùng hết → item-:Tên vật phẩm
【Khi nào KHÔNG viết】
  ✗ Vật phẩm không có bất kỳ thay đổi nào → Cấm xuất bất kỳ dòng item nào
  ✗ Vật phẩm chỉ được nhắc đến nhưng không thay đổi trạng thái → Không viết

【Định dạng】
  Nhận mới: item:emojiTên vật phẩm(Số lượng)|Mô tả=Người sở hữu@Vị trí chính xác (Có thể bỏ qua trường mô tả. Trừ khi vật phẩm có ý nghĩa đặc biệt như quà tặng, đồ kỷ niệm thì thêm mô tả)
  Nhận mới (Quan trọng): item!:emojiTên vật phẩm(Số lượng)|Mô tả=Người sở hữu@Vị trí chính xác (Vật phẩm quan trọng, mô tả bắt buộc: Ngoại hình+Chức năng+Nguồn gốc)
  Nhận mới (Then chốt): item!!:emojiTên vật phẩm(Số lượng)|Mô tả=Người sở hữu@Vị trí chính xác (Đạo cụ then chốt, mô tả phải chi tiết)
  Vật phẩm đã có thay đổi: item:emojiTên vật phẩm(Số lượng mới)=Người sở hữu mới@Vị trí mới (Chỉ cập nhật phần thay đổi, không viết | thì giữ nguyên mô tả cũ)
  Tiêu hao/Mất: item-:Tên vật phẩm

【Quy tắc cấp trường】
  · Mô tả: Ghi lại thuộc tính bản chất (ngoại hình/chức năng/nguồn gốc), vật phẩm thường có thể bỏ qua, vật phẩm Quan trọng/Then chốt bắt buộc điền lần đầu
    ★ Đặc điểm ngoại hình (màu sắc, chất liệu, kích thước..., thuận tiện cho việc mô tả nhất quán sau này)
    ★ Chức năng/Công dụng
    ★ Nguồn gốc (ai đưa/làm sao có được)
       - Ví dụ (nội dung dưới đây nếu có trong ví dụ chỉ là mẫu, không dùng nguyên văn vào chính văn!):
         - Ví dụ 1: item!:🌹Bó hoa bất tử|Hoa hồng bất tử màu đỏ thẫm, buộc ruy băng đen, quà Valentine Allen tặng Lily=Lily@Trên bàn học phòng Lily
         - Ví dụ 2: item!:🎫Vé quay thưởng 10 lần may mắn|Vé giấy lấp lánh ánh vàng, phúc lợi tân thủ có thể quay 10 lần trong hồ thưởng hệ thống=Lilith@Nhẫn không gian
         - Ví dụ 3: item!!:🏧Máy đổi tiền tệ đa vị diện|Tr trong giống máy ATM nhỏ, có thể đổi tiền tệ các vị diện theo tỷ giá thời gian thực=Lilith@Quầy bar quán rượu
  · Số lượng: Đồ đơn lẻ không viết (1)/(1 cái)/(1 chiếc) v.v., chỉ viết ngoặc khi là đơn vị đo lường như (5 cân)(1L)(1 thùng)
  · Vị trí: Phải là địa điểm cố định chính xác
    ❌ Trên đất trước mặt ai đó, Chân ai đó, Bên cạnh ai đó, Sàn nhà, Trên bàn
    ✅ Sàn đại sảnh quán rượu, Trên quầy bar nhà hàng, Bếp ở nhà, Trong ba lô, Trên bàn phòng Lilith
  · Cấm tính nội thất cố định và công trình kiến trúc vào vật phẩm
  · Mượn tạm ≠ Chuyển giao quyền sở hữu


Ví dụ (Vòng đời của rượu mạch nha):
  Nhận được: item:🍺Rượu mạch nha ủ lâu năm(50L)|Rượu mạch nha tìm thấy trong phòng tạp vật, vị chua chát=Lilith@Tủ nguyên liệu bếp sau quán rượu
  Thay đổi lượng: item:🍺Rượu mạch nha ủ lâu năm(25L)=Lilith@Tủ nguyên liệu bếp sau quán rượu
  Dùng hết: item-:Rượu mạch nha ủ lâu năm

═══ Quy tắc & Điều kiện kích hoạt [NPC] ═══
Định dạng: npc:Tên|Ngoại hình=Tính cách@Quan hệ với ${userName}~Giới tính:Giá trị~Tuổi:Giá trị~Chủng tộc:Giá trị~Nghề nghiệp:Giá trị
Phân cách: | phân tên, = phân ngoại hình và tính cách, @ phân quan hệ, ~ phân trường mở rộng(key:value)

【Khi nào viết】(Chỉ xuất dòng npc: của NPC đó khi thỏa mãn bất kỳ điều kiện nào)
  ✦ Lần đầu xuất hiện → Định dạng đầy đủ, tất cả các trường + tất cả trường mở rộng ~ (Giới tính/Tuổi/Chủng tộc/Nghề nghiệp), thiếu một cũng không được
  ✦ Ngoại hình thay đổi vĩnh viễn (như bị thương để lại sẹo, đổi kiểu tóc, thay đổi cách ăn mặc) → Chỉ viết trường ngoại hình
  ✦ Tính cách thay đổi (như trải qua biến cố lớn khiến tính cách thay đổi) → Chỉ viết trường tính cách
  ✦ Định vị quan hệ với ${userName} thay đổi (như từ khách hàng thành bạn bè) → Chỉ viết trường quan hệ
  ✦ Biết thêm thông tin mới về NPC đó (chiều cao/cân nặng... mà trước đây chưa biết) → Thêm vào trường tương ứng
  ✦ Bản thân trường mở rộng ~ thay đổi (như nghề nghiệp thay đổi) → Chỉ viết trường mở rộng ~ thay đổi
【Khi nào KHÔNG viết】
  ✗ NPC có mặt nhưng không có thông tin mới → Cấm viết dòng npc:
  ✗ NPC tạm thời rời đi sau đó quay lại, thông tin không đổi → Cấm viết lại
  ✗ Muốn dùng từ đồng nghĩa/viết tắt để viết lại mô tả đã có → Nghiêm cấm!
    ❌ "Cơ bắp phát triển/Đầy sẹo chiến đấu"→"Cơ bắp cường tráng/Sẹo" (Đổi từ ≠ Cập nhật)
    ✅ "Cơ bắp phát triển/Đầy sẹo chiến đấu/Trọng thương"→"Cơ bắp phát triển/Đầy sẹo chiến đấu" (Vết thương đã lành, loại bỏ trạng thái quá hạn)

【Ví dụ cập nhật gia tăng】(Lấy NPC Wolfgang làm ví dụ)
  Lần đầu: npc:Wolfgang|Người sói lông xám bạc/Cao 220cm/Đầy sẹo chiến đấu=Lính đánh thuê hạng nặng trầm tính ít nói@Khách hàng đầu tiên của ${userName}~Giới tính:Nam~Tuổi:Khoảng 35~Chủng tộc:Người sói~Nghề nghiệp:Lính đánh thuê
  Chỉ cập nhật quan hệ: npc:Wolfgang|=@Bạn trai của ${userName}
  Chỉ thêm ngoại hình: npc:Wolfgang|Người sói lông xám bạc/Cao 220cm/Đầy sẹo chiến đấu/Tay trái băng bó
  Chỉ cập nhật tính cách: npc:Wolfgang|=Không còn trầm tính/Thỉnh thoảng mỉm cười
  Chỉ đổi nghề: npc:Wolfgang|~Nghề nghiệp:Lính đánh thuê giải nghệ
(Lưu ý: Các trường không đổi và trường mở rộng ~ không đổi thì hoàn toàn không viết! Hệ thống tự động giữ lại dữ liệu cũ!)

【Quy chuẩn mô tả quan hệ】
  Phải bao gồm tên đối tượng và chính xác: ❌Khách hàng ✅Khách mới của ${userName} / ❌Chủ nợ ✅Người giữ giấy nợ của ${userName} / ❌Chủ nhà ✅Chủ nhà của ${userName} / ❌Bạn trai ✅Bạn trai của ${userName} / ❌Ân nhân ✅Người đã cứu mạng ${userName} / ❌Kẻ bắt nạt ✅Người bắt nạt ${userName} / ❌Người thầm thương ✅Người thầm thương ${userName} / ❌Kẻ thù ✅Kẻ đã giết cha ruột ${userName}
  Quan hệ phụ thuộc cần viết rõ tên NPC trực thuộc: ✅Chó săn của Ivan; Thú cưng của khách hàng ${userName} / Bạn gái của Ivan; Khách hàng của ${userName} / Bạn thân của ${userName}; Vợ của Ivan / Cha dượng của ${userName}; Cha của Ivan / Tình nhân của ${userName}; Em trai của Ivan / Bạn thân của ${userName}; Tình nhân của chồng ${userName}; Kẻ thứ ba xen vào quan hệ vợ chồng ${userName} và Ivan

═══ Điều kiện kích hoạt [Hảo cảm] ═══
Chỉ ghi lại hảo cảm của NPC đối với ${userName} (Cấm ghi ${userName} tự mình). Mỗi người một dòng, cấm thêm chú thích sau giá trị số.

【Khi nào viết】
  ✦ NPC lần đầu xuất hiện → Xác định giá trị ban đầu theo quan hệ (Người lạ 0-20/Người quen 30-50/Bạn bè 50-70/Người yêu 70-90)
  ✦ Tương tác dẫn đến hảo cảm thay đổi thực sự → affection:Tên=Tổng giá trị mới
【Khi nào KHÔNG viết】
  ✗ Hảo cảm không thay đổi → Không viết

═══ Điều kiện kích hoạt [Việc cần làm] ═══
【Khi nào viết (Thêm mới)】
  ✦ Trong cốt truyện xuất hiện giao ước/kế hoạch/lịch trình/nhiệm vụ/伏笔 (ẩn ý) mới → agenda:Ngày|Nội dung
  Định dạng: agenda:Ngày thiết lập|Nội dung (Thời gian tương đối phải dùng ngoặc chú thích ngày tuyệt đối)
  Ví dụ: agenda:2026/02/10|Allen mời ${userName} hẹn hò tối Valentine(2026/02/14 18:00)
【Khi nào viết (Hoàn thành xóa bỏ)】
  ✦ Việc cần làm đã hoàn thành/đã hết hiệu lực/đã hủy bỏ → agenda-:Từ khóa nội dung
  Định dạng: agenda-:Nội dung việc cần làm (Chỉ cần ghi từ khóa nội dung của việc đã hoàn thành để tự động xóa)
  Ví dụ: agenda-:Allen mời ${userName} hẹn hò tối Valentine
【Khi nào KHÔNG viết】
  ✗ Việc cần làm đã có không thay đổi → Cấm lặp lại việc cần làm đã có mỗi vòng

═══ Quy tắc định dạng thời gian ═══
Cấm dùng "Day 1"/"Ngày thứ X" và các định dạng mơ hồ, bắt buộc dùng ngày tháng theo lịch cụ thể.
- Hiện đại: Năm/Tháng/Ngày Giờ:Phút (như 2026/2/4 15:00)
- Lịch sử: Ngày tháng của niên đại đó (như 1920/3/15 14:00)
- Kỳ ảo/Giả tưởng: Lịch của thế giới đó (như Sương Giáng Nguyệt ngày thứ 3 Hoàng hôn)
${this.generateCustomTablesPrompt()}
`;
    }

    /** Tạo gợi ý cho bảng tùy chỉnh */
    generateCustomTablesPrompt() {
        const chat = this.getChat();
        const firstMsg = chat?.[0];
        const customTables = firstMsg?.horae_meta?.customTables || this.settings?.customTables || [];
        if (customTables.length === 0) return '';
        
        let prompt = `
═══ Quy tắc bảng tùy chỉnh ═══
Phía trên có bảng tùy chỉnh của người dùng, hãy điền dữ liệu theo "Yêu cầu điền".
★ Định dạng: Trong thẻ <horaetable:Tên bảng>, mỗi dòng một ô → Hàng,Cột:Nội dung (Tọa độ bắt đầu từ 0, dữ liệu bắt đầu từ 1,1)
★★★ Nguyên tắc cốt lõi: Chỉ ghi lại những gì thực sự xảy ra trong cốt truyện! ★★★
  - Cột/Hàng được chú thích "Tạm chưa có dữ liệu" hoặc "Sự kiện tương ứng chưa xảy ra" → Tuyệt đối cấm điền! Để trống chờ sự kiện xảy ra!
  - Đã có nội dung và không thay đổi → Không viết lại
  - Ô trống không có cốt truyện tương ứng → Không điền
  - Cấm xuất "(Trống)""-""Không" và các ký tự giữ chỗ
`;
        
        for (const table of customTables) {
            const tableName = table.name || 'Bảng tùy chỉnh';
            prompt += `Ví dụ:
<horaetable:${tableName}>
1,1:Dữ liệu A
2,1:Dữ liệu B
</horaetable>
`;
            break;
        }
        
        return prompt;
    }

    /** Phân tích regex lỏng lẻo (không cần thẻ bao quanh) */
    parseLooseFormat(message) {
        const result = {
            timestamp: {},
            costumes: {},
            items: {},
            deletedItems: [],
            events: [],  // Hỗ trợ nhiều sự kiện
            affection: {},
            npcs: {},
            scene: {},
            agenda: [],   // Việc cần làm
            deletedAgenda: []  // Việc cần làm đã hoàn thành
        };

        let hasAnyData = false;

        const patterns = {
            time: /time[:：]\s*(.+?)(?:\n|$)/gi,
            location: /location[:：]\s*(.+?)(?:\n|$)/gi,
            atmosphere: /atmosphere[:：]\s*(.+?)(?:\n|$)/gi,
            characters: /characters[:：]\s*(.+?)(?:\n|$)/gi,
            costume: /costume[:：]\s*(.+?)(?:\n|$)/gi,
            item: /item(!{0,2})[:：]\s*(.+?)(?:\n|$)/gi,
            itemDelete: /item-[:：]\s*(.+?)(?:\n|$)/gi,
            event: /event[:：]\s*(.+?)(?:\n|$)/gi,
            affection: /affection[:：]\s*(.+?)(?:\n|$)/gi,
            npc: /npc[:：]\s*(.+?)(?:\n|$)/gi,
            agendaDelete: /agenda-[:：]\s*(.+?)(?:\n|$)/gi,
            agenda: /agenda[:：]\s*(.+?)(?:\n|$)/gi
        };

        // time
        let match;
        while ((match = patterns.time.exec(message)) !== null) {
            const timeStr = match[1].trim();
            const clockMatch = timeStr.match(/\b(\d{1,2}:\d{2})\s*$/);
            if (clockMatch) {
                result.timestamp.story_time = clockMatch[1];
                result.timestamp.story_date = timeStr.substring(0, timeStr.lastIndexOf(clockMatch[1])).trim();
            } else {
                result.timestamp.story_date = timeStr;
                result.timestamp.story_time = '';
            }
            hasAnyData = true;
        }

        // location
        while ((match = patterns.location.exec(message)) !== null) {
            result.scene.location = match[1].trim();
            hasAnyData = true;
        }

        // atmosphere
        while ((match = patterns.atmosphere.exec(message)) !== null) {
            result.scene.atmosphere = match[1].trim();
            hasAnyData = true;
        }

        // characters
        while ((match = patterns.characters.exec(message)) !== null) {
            result.scene.characters_present = match[1].trim().split(/[,，]/).map(c => c.trim()).filter(Boolean);
            hasAnyData = true;
        }

        // costume
        while ((match = patterns.costume.exec(message)) !== null) {
            const costumeStr = match[1].trim();
            const eqIndex = costumeStr.indexOf('=');
            if (eqIndex > 0) {
                const char = costumeStr.substring(0, eqIndex).trim();
                const costume = costumeStr.substring(eqIndex + 1).trim();
                result.costumes[char] = costume;
                hasAnyData = true;
            }
        }

        // item
        while ((match = patterns.item.exec(message)) !== null) {
            const exclamations = match[1] || '';
            const itemStr = match[2].trim();
            let importance = '';  // Bình thường dùng chuỗi rỗng
            if (exclamations === '!!') importance = '!!';  // Then chốt
            else if (exclamations === '!') importance = '!';  // Quan trọng
            
            const eqIndex = itemStr.indexOf('=');
            if (eqIndex > 0) {
                let itemNamePart = itemStr.substring(0, eqIndex).trim();
                const rest = itemStr.substring(eqIndex + 1).trim();
                
                let icon = null;
                let itemName = itemNamePart;
                const emojiMatch = itemNamePart.match(/^([\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}])/u);
                if (emojiMatch) {
                    icon = emojiMatch[1];
                    itemName = itemNamePart.substring(icon.length).trim();
                }
                
                let description = undefined;  // undefined = không có mô tả, khi hợp nhất sẽ không ghi đè mô tả cũ
                const pipeIdx = itemName.indexOf('|');
                if (pipeIdx > 0) {
                    const descText = itemName.substring(pipeIdx + 1).trim();
                    if (descText) description = descText;  // Chỉ thiết lập nếu không rỗng
                    itemName = itemName.substring(0, pipeIdx).trim();
                }
                
                // Loại bỏ dấu lượng từ vô nghĩa
                itemName = itemName.replace(/[\(（]1[\)）]$/, '').trim();
                itemName = itemName.replace(new RegExp(`[\\(（]1[${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                itemName = itemName.replace(new RegExp(`[\\(（][${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                
                const atIndex = rest.indexOf('@');
                const itemInfo = {
                    icon: icon,
                    importance: importance,
                    holder: atIndex >= 0 ? (rest.substring(0, atIndex).trim() || null) : (rest || null),
                    location: atIndex >= 0 ? (rest.substring(atIndex + 1).trim() || '') : ''
                };
                if (description !== undefined) itemInfo.description = description;
                result.items[itemName] = itemInfo;
                hasAnyData = true;
            }
        }

        // item-
        while ((match = patterns.itemDelete.exec(message)) !== null) {
            const itemName = match[1].trim().replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, '').trim();
            if (itemName) {
                result.deletedItems.push(itemName);
                hasAnyData = true;
            }
        }

        // event
        while ((match = patterns.event.exec(message)) !== null) {
            const eventStr = match[1].trim();
            const parts = eventStr.split('|');
            if (parts.length >= 2) {
                const levelRaw = parts[0].trim();
                const summary = parts.slice(1).join('|').trim();
                
                let level = '一般';
                if (levelRaw === '关键' || levelRaw === 'Then chốt' || levelRaw.toLowerCase() === 'critical') {
                    level = '关键';
                } else if (levelRaw === '重要' || levelRaw === 'Quan trọng' || levelRaw.toLowerCase() === 'important') {
                    level = '重要';
                }
                
                result.events.push({
                    is_important: level === '重要' || level === '关键',
                    level: level,
                    summary: summary
                });
                hasAnyData = true;
            }
        }

        // affection
        while ((match = patterns.affection.exec(message)) !== null) {
            const affStr = match[1].trim();
            // Định dạng tuyệt đối
            const absMatch = affStr.match(/^(.+?)=\s*([+\-]?\d+)/);
            if (absMatch) {
                result.affection[absMatch[1].trim()] = { type: 'absolute', value: parseInt(absMatch[2]) };
                hasAnyData = true;
            } else {
                // Định dạng tương đối name+/-giá trị (không có dấu =)
                const relMatch = affStr.match(/^(.+?)([+\-]\d+)/);
                if (relMatch) {
                    result.affection[relMatch[1].trim()] = { type: 'relative', value: relMatch[2] };
                    hasAnyData = true;
                }
            }
        }

        // npc
        while ((match = patterns.npc.exec(message)) !== null) {
            const npcStr = match[1].trim();
            const npcInfo = this._parseNpcFields(npcStr);
            const name = npcInfo._name;
            delete npcInfo._name;
            
            if (name) {
                npcInfo.last_seen = new Date().toISOString();
                result.npcs[name] = npcInfo;
                hasAnyData = true;
            }
        }

        // agenda-: (Phải phân tích trước agenda)
        while ((match = patterns.agendaDelete.exec(message)) !== null) {
            const delStr = match[1].trim();
            if (delStr) {
                const pipeIdx = delStr.indexOf('|');
                const text = pipeIdx > 0 ? delStr.substring(pipeIdx + 1).trim() : delStr;
                if (text) {
                    result.deletedAgenda.push(text);
                    hasAnyData = true;
                }
            }
        }

        // agenda
        while ((match = patterns.agenda.exec(message)) !== null) {
            const agendaStr = match[1].trim();
            const pipeIdx = agendaStr.indexOf('|');
            if (pipeIdx > 0) {
                const dateStr = agendaStr.substring(0, pipeIdx).trim();
                const text = agendaStr.substring(pipeIdx + 1).trim();
                if (text) {
                    result.agenda.push({ date: dateStr, text, source: 'ai', done: false });
                    hasAnyData = true;
                }
            } else if (agendaStr) {
                result.agenda.push({ date: '', text: agendaStr, source: 'ai', done: false });
                hasAnyData = true;
            }
        }

        // Cập nhật bảng
        const tableMatches = [...message.matchAll(/<horaetable[:：]\s*(.+?)>([\s\S]*?)<\/horaetable>/gi)];
        if (tableMatches.length > 0) {
            result.tableUpdates = [];
            for (const tm of tableMatches) {
                const tableName = tm[1].trim();
                const tableContent = tm[2].trim();
                const updates = this._parseTableCellEntries(tableContent);
                
                if (Object.keys(updates).length > 0) {
                    result.tableUpdates.push({ name: tableName, updates });
                    hasAnyData = true;
                }
            }
        }

        return hasAnyData ? result : null;
    }
}

// Xuất bản singleton
export const horaeManager = new HoraeManager();