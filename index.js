import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { 
    loadWorldInfo, 
    saveWorldInfo,
    createNewWorldInfo,
    createWorldInfoEntry
} from "../../../world-info.js";
import { characters } from "../../../../script.js";
import { eventSource, event_types } from "../../../../script.js";

const extensionName = "character-journal-system";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}/`;

// 常量定义
const JOURNAL_COMMENT_PREFIX = "【Character Journal】";
const ARCHIVE_COMMENT_PREFIX = "【Character Archive】";
const PROGRESS_SEAL_REGEX = /【已更新至第 (\d+) 楼】$/;

// 默认设置
const defaultSettings = {
    enabled: false,
    target: "character_main",
    dedicatedWorldbook: "",
    detectionMode: "auto",
    manualCharacters: "",
    excludeNames: "",
    excludeUser: true,
    autoUpdate: false,
    useWorldInfo: true,
    
    updateThreshold: 20,
    journalPrompt: `你是记忆记录助手。请为**在本轮对话中出场的角色**写第一人称日志。

重要规则：
1. 只为实际出场并有对话/行动的角色写日志
2. 未出场的角色不要输出任何内容（直接跳过）
3. 使用第一人称（我、我的）
4. 每个事件独立成条，格式：时间标记 + 事件 + 感受/想法
5. 时间标记可灵活使用：具体时间（早上/下午）、日期、节日、事件节点等
6. 每条日志控制在50-100字左右

输出格式示例：
===角色:炽霞===
• 早上巡逻时 - 遇到了杨，昨晚的事让我有些不知所措，但还是强装镇定。走路时身体还有些不适，希望他没注意到。
• 巡逻途中 - 听到呼救声，立刻切换到工作模式。杨跟了上来，虽然有些意外，但多个人手总是好的。
===角色:秧秧===
• 上午 - 继续照顾杨和炽霞，看着两人的互动觉得有些好笑。年轻人的感情总是这么青涩可爱。
===END===

禁止事项：
❌ 不要为未出场的角色输出任何内容
❌ 不要输出"未出场"、"无"等占位符
❌ 禁止生成男性的日志
❌ 不要为非角色实体生成日志（世界名、地点、组织等）`,
    
    autoRefine: false,
    refineThreshold: 5000,
    keepRecent: 5,
    refinePrompt: `你是角色档案分析师。请将以下日志条目精炼成简洁的角色档案。

提取并整理：
1. 核心性格特征
2. 关键关系及感受
3. 重要经历
4. 角色成长轨迹

输出格式：
【性格特征】
[2-3句话]

【人际关系】
- 角色X: [关系与感受]

【重要经历】
- [事件1]

【角色成长】
[变化总结]`,
    
    keywordsTemplate: "{name}",
    insertionPosition: 2,
    entryOrder: 90,
    depth: 4,
    
    api: {
        url: "",
        key: "",
        model: "",
        maxTokens: 2000
    }
};

// 获取目标世界书名称
async function getTargetLorebookName() {
    const settings = extension_settings[extensionName];
    const context = getContext();
    
    if (settings.target === "character_main") {
        // 获取当前聊天的世界书
        const chatMetadata = context.chat_metadata || {};
        const chatWorldbook = chatMetadata.world_info;
        
        if (chatWorldbook) {
            return chatWorldbook;
        }
        
        // 如果没有聊天世界书，创建一个新的
        const chatId = context.chatId || "chat";
        const charName = context.name2 || "character";
        return `${charName}-Journal-${chatId}`;
    } else {
        // 专用世界书模式
        if (settings.dedicatedWorldbook && settings.dedicatedWorldbook.trim()) {
            // 使用自定义名称
            return settings.dedicatedWorldbook.trim();
        } else {
            // 自动生成名称
            const chatId = context.chatId || "unknown";
            return `CharacterJournal-${chatId}`;
        }
    }
}

// 读取角色日志进度
async function readJournalProgress(lorebookName, characterName) {
    try {
        const bookData = await loadWorldInfo(lorebookName);
        if (!bookData || !bookData.entries) {
            return 0;
        }
        
        const journalEntry = Object.values(bookData.entries).find(
            e => e.comment === `${JOURNAL_COMMENT_PREFIX}${characterName}` && !e.disable
        );
        
        if (!journalEntry) {
            return 0;
        }
        
        const match = journalEntry.content.match(PROGRESS_SEAL_REGEX);
        return match ? parseInt(match[1], 10) : 0;
    } catch (error) {
        console.error(`[角色日志] 读取${characterName}的进度失败:`, error);
        return 0;
    }
}

// 提取content标签内的内容
function extractContentTag(text) {
    // 尝试提取 <content> 标签内容
    const contentMatch = text.match(/<content>([\s\S]*?)<\/content>/);
    if (contentMatch && contentMatch[1].trim()) {
        return contentMatch[1].trim();
    }
    
    // 如果没有content标签，返回原文本
    // 但要移除其他标签（thinking, tableEdit, chat, details等）
    let cleaned = text;
    
    // 移除thinking标签及内容
    cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
    
    // 移除tableEdit标签及内容
    cleaned = cleaned.replace(/<tableEdit>[\s\S]*?<\/tableEdit>/g, '');
    
    // 移除chat标签及内容
    cleaned = cleaned.replace(/<chat>[\s\S]*?<\/chat>/g, '');
    
    // 移除details标签及内容（包括折叠的手机、状态等）
    cleaned = cleaned.replace(/<details>[\s\S]*?<\/details>/g, '');
    
    // 移除其他常见标签
    cleaned = cleaned.replace(/<Phone>[\s\S]*?<\/Phone>/g, '');
    cleaned = cleaned.replace(/<StatusBlocks>[\s\S]*?<\/StatusBlocks>/g, '');
    
    return cleaned.trim();
}

// 获取未记录的消息
function getUnloggedMessages(startFloor, endFloor, characterName) {
    const context = getContext();
    const chat = context.chat;
    
    if (!chat || chat.length === 0) return [];
    
    // 确保startFloor至少从第2楼开始，跳过第1楼（可能包含其他扩展的缓存数据）
    const safeStartFloor = Math.max(startFloor, 2);
    
    if (safeStartFloor > endFloor) {
        console.log('[角色日志] 跳过第1楼后没有可读取的消息');
        return [];
    }
    
    const historySlice = chat.slice(safeStartFloor - 1, endFloor);
    const userName = context.name1 || '用户';
    
    console.log(`[角色日志] 实际读取范围: 第${safeStartFloor}-${endFloor}楼 (已排除第1楼)`);
    
    return historySlice.map((msg, index) => {
        const author = msg.is_user ? userName : (msg.name || context.name2 || '角色');
        // 提取content标签内容
        const cleanedContent = extractContentTag(msg.mes);
        
        return {
            floor: safeStartFloor + index,
            author: author,
            content: cleanedContent,
            isTarget: author === characterName
        };
    }).filter(m => m.content);
}

// 调用AI生成日志
async function callAI(messages) {
    const settings = extension_settings[extensionName];
    
    console.log('[角色日志] callAI开始');
    console.log('[角色日志] 是否使用自定义API:', !!settings.api.url);
    
    // 如果有自定义API设置
    if (settings.api.url) {
        try {
            let apiUrl = settings.api.url.trim();
            if (!apiUrl.endsWith('/v1/chat/completions')) {
                if (apiUrl.endsWith('/')) {
                    apiUrl = apiUrl.slice(0, -1);
                }
                if (!apiUrl.includes('/v1/chat/completions')) {
                    apiUrl += '/v1/chat/completions';
                }
            }
            
            console.log('[角色日志] 自定义API URL:', apiUrl);
            console.log('[角色日志] 模型:', settings.api.model);
            console.log('[角色日志] max_tokens:', settings.api.maxTokens);
            
            const requestBody = {
                model: settings.api.model || 'gpt-3.5-turbo',
                messages: messages,
                temperature: 0.7,
                max_tokens: parseInt(settings.api.maxTokens) || 2000
            };
            
            console.log('[角色日志] 请求体大小:', JSON.stringify(requestBody).length, '字符');
            console.log('[角色日志] 发送API请求...');
            
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${settings.api.key || ''}`
                },
                body: JSON.stringify(requestBody)
            });
            
            console.log('[角色日志] API响应状态:', response.status);
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('[角色日志] API错误响应:', errorText);
                throw new Error(`API请求失败: ${response.status} - ${errorText.substring(0, 200)}`);
            }
            
            const data = await response.json();
            console.log('[角色日志] API返回数据结构:', Object.keys(data));
            
            if (!data.choices || !data.choices[0] || !data.choices[0].message) {
                console.error('[角色日志] API返回数据异常:', data);
                throw new Error('API返回数据格式不正确');
            }
            
            const content = data.choices[0].message.content;
            console.log('[角色日志] 提取到内容长度:', content?.length || 0);
            return content;
        } catch (error) {
            console.error('[角色日志] API调用失败:', error);
            console.error('[角色日志] 错误堆栈:', error.stack);
            toastr.error(`API调用失败: ${error.message}`, '角色日志');
            return null;
        }
    }
    
    // 使用SillyTavern的默认API
    try {
        console.log('[角色日志] 使用ST默认API');
        const generateRaw = window.generateRaw || window.Generate?.generateRaw;
        if (!generateRaw) {
            throw new Error('找不到SillyTavern的生成函数');
        }
        
        const prompt = messages.map(m => m.content).join('\n\n');
        console.log('[角色日志] 合并后的提示词长度:', prompt.length);
        console.log('[角色日志] 调用generateRaw...');
        
        const result = await generateRaw(prompt, '', false, false);
        
        console.log('[角色日志] generateRaw返回结果长度:', result?.length || 0);
        return result;
    } catch (error) {
        console.error('[角色日志] 调用ST API失败:', error);
        console.error('[角色日志] 错误堆栈:', error.stack);
        toastr.error(`生成日志失败: ${error.message}`, '角色日志');
        return null;
    }
}

// 解析角色日志
function parseCharacterJournals(response, allowedCharacters = null) {
    const journals = new Map();
    
    // 匹配格式: ===角色:Name===\n内容\n
    const regex = /===角色:([^=]+)===\s*\n([\s\S]*?)(?=\n===角色:|===END===|$)/g;
    let match;
    
    while ((match = regex.exec(response)) !== null) {
        const characterName = match[1].trim();
        const journalContent = match[2].trim();
        
        // 白名单过滤：如果指定了允许的角色列表，只处理列表中的角色
        if (allowedCharacters && allowedCharacters.length > 0) {
            if (!allowedCharacters.includes(characterName)) {
                console.log(`[角色日志] 跳过未授权的角色: ${characterName}`);
                continue;
            }
        }
        
        if (journalContent && !journalContent.includes('【本轮未出场】')) {
            journals.set(characterName, journalContent);
        }
    }
    
    return journals;
}

// AI识别角色
async function detectCharactersByAI(messages, existingCharacters = []) {
    const context = getContext();
    const settings = extension_settings[extensionName];
    const userName = context.name1 || '用户';
    const mainCharName = context.name2 || '角色';
    
    const formattedHistory = messages
        .map(m => `【第 ${m.floor} 楼】 ${m.author}: ${m.content}`)
        .join('\n');
    
    // 获取排除列表
    const excludeList = [mainCharName]; // 总是排除角色卡名字
    if (settings.excludeUser) {
        excludeList.push(userName);
    }
    if (settings.excludeNames) {
        excludeList.push(...settings.excludeNames.split(',').map(n => n.trim()).filter(Boolean));
    }
    // 添加已存在的角色到排除列表
    if (existingCharacters && existingCharacters.length > 0) {
        excludeList.push(...existingCharacters);
        console.log('[角色日志] 排除已有角色:', existingCharacters);
    }
    
    const detectPrompt = `你是角色识别助手。请分析以下小说式剧情文本，识别出所有出场的角色名字。

要求：
1. 只返回角色的名字，用逗号分隔
2. 不要包含这些名字：${excludeList.join('、')}
3. 不要包含地点、物品、组织等非角色名
4. 如果没有识别到角色，返回：无

文本内容：
${formattedHistory}

请直接输出角色名列表（格式：角色1, 角色2, 角色3）：`;
    
    const aiMessages = [
        { role: 'user', content: detectPrompt }
    ];
    
    console.log('[角色日志] 让AI识别角色...');
    const response = await callAI(aiMessages);
    
    if (!response) {
        return [];
    }
    
    // 解析AI返回的角色列表
    const detectedNames = response
        .replace(/^.*?[:：]\s*/, '') // 移除可能的前缀
        .split(/[,，、]/)
        .map(name => name.trim())
        .filter(name => name && name !== '无' && !excludeList.includes(name));
    
    console.log('[角色日志] AI识别到的角色:', detectedNames);
    
    return detectedNames.map(name => ({
        name: name,
        count: 0,
        isUser: false
    }));
}

// 获取角色相关的世界书信息
async function getCharacterWorldInfo(characterName) {
    try {
        const context = getContext();
        const chatMetadata = context.chat_metadata || {};
        const worldbooks = [];
        
        // 获取当前聊天绑定的世界书
        if (chatMetadata.world_info) {
            worldbooks.push(chatMetadata.world_info);
            console.log(`[角色日志] 添加聊天世界书: ${chatMetadata.world_info}`);
        }
        
        // 获取角色卡绑定的世界书（使用正确的路径）
        if (context.characterId !== undefined) {
            const char = characters[context.characterId];
            const worldbookName = char?.data?.extensions?.world;
            if (worldbookName) {
                worldbooks.push(worldbookName);
                console.log(`[角色日志] 添加角色世界书: ${worldbookName}`);
            }
        }
        
        let characterInfo = '';
        
        // 遍历所有世界书，查找与该角色相关的条目
        for (const bookName of worldbooks) {
            try {
                const bookData = await loadWorldInfo(bookName);
                if (!bookData || !bookData.entries) continue;
                
                // 查找包含该角色名的条目
                const relevantEntries = Object.values(bookData.entries).filter(entry => {
                    if (entry.disable) return false;
                    
                    // 检查关键词是否包含角色名
                    const allKeys = [...(entry.key || []), ...(entry.keysecondary || [])];
                    return allKeys.some(key => 
                        key.toLowerCase().includes(characterName.toLowerCase()) ||
                        characterName.toLowerCase().includes(key.toLowerCase())
                    );
                });
                
                // 提取相关信息
                for (const entry of relevantEntries) {
                    if (entry.content && !entry.comment?.includes('Journal') && !entry.comment?.includes('Archive')) {
                        characterInfo += `\n${entry.content}\n`;
                    }
                }
            } catch (error) {
                console.log(`[角色日志] 无法读取世界书 ${bookName}`);
            }
        }
        
        return characterInfo.trim();
    } catch (error) {
        console.error('[角色日志] 获取角色信息失败:', error);
        return '';
    }
}

// 生成角色日志
async function generateCharacterJournals(startFloor, endFloor, rangeInfo) {
    const settings = extension_settings[extensionName];
    const messages = getUnloggedMessages(startFloor, endFloor, null);
    
    if (messages.length === 0) {
        toastr.warning('选定范围内没有有效消息', '角色日志');
        return null;
    }
    
    const formattedHistory = messages
        .map(m => `【第 ${m.floor} 楼】 ${m.author}: ${m.content}`)
        .join('\n');
    
    // 根据检测模式获取角色列表
    let finalCharacters;
    
    // 如果有明确指定的角色列表，直接使用
    if (rangeInfo && rangeInfo.characters && rangeInfo.characters.length > 0) {
        finalCharacters = rangeInfo.characters.map(name => ({
            name: name,
            count: 0,
            isUser: false
        }));
        console.log('[角色日志] 使用指定的角色列表:', rangeInfo.characters);
    } else if (settings.detectionMode === "manual" && settings.manualCharacters) {
        // 手动模式：使用用户输入的角色列表
        const manualNames = settings.manualCharacters
            .split(',')
            .map(name => name.trim())
            .filter(Boolean);
        
        if (manualNames.length === 0) {
            toastr.warning('请在设置中填写要跟踪的角色名', '角色日志');
            return null;
        }
        
        finalCharacters = manualNames.map(name => ({
            name: name,
            count: 0,
            isUser: false
        }));
        
        console.log('[角色日志] 手动模式 - 使用用户指定的角色:', manualNames);
    } else {
        // 自动模式：使用AI识别角色
        toastr.info('AI正在识别角色...', '角色日志');
        // 如果有传入已存在的角色列表，传递给AI识别函数用于排除
        const existingChars = rangeInfo?.existingCharacters || [];
        finalCharacters = await detectCharactersByAI(messages, existingChars);
        
        if (!finalCharacters || finalCharacters.length === 0) {
            console.log('[角色日志] AI未识别到新角色（可能都已存在）');
            toastr.warning('AI未能识别到新角色', '角色日志');
            return null;
        }
    }
    
    const characterList = finalCharacters.map(c => c.name).join(', ');
    
    // 构建包含角色资料的提示
    let characterInfoSection = '';
    
    // 根据设置决定是否读取世界书
    if (settings.useWorldInfo) {
        toastr.info('正在获取角色资料...', '角色日志');
        const characterInfoMap = new Map();
        
        for (const char of finalCharacters) {
            const info = await getCharacterWorldInfo(char.name);
            if (info) {
                characterInfoMap.set(char.name, info);
                console.log(`[角色日志] 获取到${char.name}的资料:`, info.substring(0, 200) + '...');
            }
        }
        
        if (characterInfoMap.size > 0) {
            characterInfoSection = '\n\n===角色资料===\n';
            for (const [name, info] of characterInfoMap.entries()) {
                characterInfoSection += `\n【${name}】\n${info}\n`;
            }
            characterInfoSection += '===资料结束===\n';
        }
        
        console.log('[角色日志] 包含角色资料数:', characterInfoMap.size);
    } else {
        console.log('[角色日志] 已禁用世界书读取，跳过角色资料获取');
    }
    
    const aiMessages = [
        { 
            role: 'system', 
            content: settings.journalPrompt 
        },
        { 
            role: 'user', 
            content: `要跟踪的角色: ${characterList}${characterInfoSection}\n对话记录:\n${formattedHistory}` 
        }
    ];
    
    console.log('[角色日志] 发送给AI的角色列表:', characterList);
    console.log('[角色日志] 对话记录长度:', formattedHistory.length);
    
    toastr.info('正在生成角色日志...', '角色日志');
    
    console.log('[角色日志] 开始调用AI...');
    console.log('[角色日志] 消息内容长度:', JSON.stringify(aiMessages).length, '字符');
    
    const response = await callAI(aiMessages);
    
    console.log('[角色日志] AI调用完成');
    
    if (!response) {
        console.error('[角色日志] AI返回空响应');
        toastr.error('AI未返回任何内容', '角色日志');
        return null;
    }
    
    console.log('[角色日志] AI响应长度:', response.length, '字符');
    console.log('[角色日志] AI响应内容:', response.substring(0, 500) + '...');
    
    // 传递允许的角色列表进行白名单过滤
    const allowedNames = finalCharacters.map(c => c.name);
    const journals = parseCharacterJournals(response, allowedNames);
    console.log('[角色日志] 解析结果:', Array.from(journals.keys()));
    console.log('[角色日志] 允许的角色:', allowedNames);
    
    return journals;
}

// 更新角色日志条目
async function updateCharacterJournal(characterName, journalContent, startFloor, endFloor) {
    const settings = extension_settings[extensionName];
    
    try {
        const lorebookName = await getTargetLorebookName();
        
        let bookData;
        try {
            bookData = await loadWorldInfo(lorebookName);
        } catch (error) {
            console.log(`[角色日志] 创建新世界书: ${lorebookName}`);
            bookData = {
                entries: {},
                name: lorebookName
            };
        }
        
        if (!bookData.entries) {
            bookData.entries = {};
        }
        
        const journalComment = `${JOURNAL_COMMENT_PREFIX}${characterName}`;
        let journalEntry = Object.values(bookData.entries).find(
            e => e.comment === journalComment && !e.disable
        );
        
        const newSeal = `【已更新至第 ${endFloor} 楼】`;
        const newEntry = `\n\n---\n\n【第${startFloor}-${endFloor}楼】\n${journalContent}\n\n${newSeal}`;
        
        if (journalEntry) {
            // 更新现有条目
            const contentWithoutSeal = journalEntry.content.replace(PROGRESS_SEAL_REGEX, "").trim();
            journalEntry.content = contentWithoutSeal + newEntry;
        } else {
            // 创建新条目
            const entryKey = Date.now().toString() + '-' + characterName;
            const keywords = settings.keywordsTemplate
                .replace(/{name}/g, characterName)
                .split(',')
                .map(k => k.trim())
                .filter(Boolean);
            
            journalEntry = {
                uid: entryKey,
                key: keywords,
                keysecondary: [],
                comment: journalComment,
                content: `${characterName}的第一人称日志记录：` + newEntry,
                constant: false,
                selective: true,
                selectiveLogic: 0,
                addMemo: false,
                order: parseInt(settings.entryOrder) || 90,
                position: parseInt(settings.insertionPosition) || 2,
                disable: false,
                excludeRecursion: true,
                preventRecursion: true,
                delayUntilRecursion: false,
                probability: 100,
                useProbability: true,
                depth: parseInt(settings.depth) || 4,
                group: '',
                groupOverride: false,
                groupWeight: 100,
                scanDepth: null,
                caseSensitive: false,
                matchWholeWords: false,
                useGroupScoring: false,
                automationId: '',
                role: 0,
                vectorized: false,
                sticky: 0,
                cooldown: 0,
                delay: 0
            };
            
            bookData.entries[entryKey] = journalEntry;
        }
        
        await saveWorldInfo(lorebookName, bookData, true);
        
        console.log(`[角色日志] ${characterName}的日志已更新`);
        
        // 检查是否需要精炼
        if (settings.autoRefine && journalEntry.content.length >= settings.refineThreshold) {
            console.log(`[角色日志] ${characterName}的日志达到精炼阈值，自动触发精炼`);
            toastr.info(`${characterName}的日志达到阈值，正在自动精炼...`, '角色日志');
            
            // 自动执行精炼
            await refineCharacterJournal(characterName, lorebookName);
        }
        
        return true;
    } catch (error) {
        console.error(`[角色日志] 更新${characterName}的日志失败:`, error);
        toastr.error(`更新${characterName}的日志失败: ${error.message}`, '角色日志');
        return false;
    }
}

// 执行日志更新
async function executeJournalUpdate() {
    const settings = extension_settings[extensionName];
    const context = getContext();
    
    if (!context.chat || context.chat.length === 0) {
        toastr.warning('当前没有对话', '角色日志');
        return false;
    }
    
    try {
        const lorebookName = await getTargetLorebookName();
        
        // 读取所有已存在的角色及其进度
        const characterProgresses = new Map();
        try {
            const bookData = await loadWorldInfo(lorebookName);
            if (bookData && bookData.entries) {
                const journalEntries = Object.values(bookData.entries).filter(
                    e => e.comment && e.comment.startsWith(JOURNAL_COMMENT_PREFIX) && !e.disable
                );
                
                for (const entry of journalEntries) {
                    const charName = entry.comment.replace(JOURNAL_COMMENT_PREFIX, '');
                    const match = entry.content.match(PROGRESS_SEAL_REGEX);
                    const progress = match ? parseInt(match[1], 10) : 0;
                    characterProgresses.set(charName, progress);
                }
            }
        } catch (error) {
            console.log('[角色日志] 无法读取现有进度，将自动识别角色');
        }
        
        let updateRanges = [];
        
        if (characterProgresses.size > 0) {
            // 已有角色日志，为每个角色计算更新范围
            // 同时找出最大进度，用于识别新角色
            const maxProgress = Math.max(...Array.from(characterProgresses.values()));
            
            for (const [charName, progress] of characterProgresses.entries()) {
                const startFloor = progress + 1;
                const endFloor = Math.min(progress + settings.updateThreshold, context.chat.length);
                
                if (startFloor <= context.chat.length) {
                    updateRanges.push({
                        characters: [charName],
                        startFloor: startFloor,
                        endFloor: endFloor,
                        isExisting: true
                    });
                }
            }
            
            // 重要：在最大进度之后识别新角色（即使已有角色日志是最新的）
            if (maxProgress < context.chat.length) {
                const newCharStartFloor = maxProgress + 1;
                const newCharEndFloor = Math.min(maxProgress + settings.updateThreshold, context.chat.length);
                
                // 添加一个识别新角色的范围
                updateRanges.push({
                    characters: null, // AI自动识别
                    startFloor: newCharStartFloor,
                    endFloor: newCharEndFloor,
                    isExisting: false,
                    existingCharacters: Array.from(characterProgresses.keys()) // 传递已存在的角色列表用于排除
                });
                
                console.log(`[角色日志] 将在第${newCharStartFloor}-${newCharEndFloor}楼范围内识别新角色`);
            } else if (updateRanges.length === 0) {
                toastr.info('所有已跟踪的角色日志都是最新的，且没有新消息', '角色日志');
            }
        } else {
            // 没有任何日志，从头开始
            const startFloor = 1;
            const endFloor = Math.min(settings.updateThreshold, context.chat.length);
            updateRanges.push({
                characters: null, // AI自动识别
                startFloor: startFloor,
                endFloor: endFloor,
                isExisting: false
            });
        }
        
        if (updateRanges.length === 0) {
            toastr.info('所有角色日志都是最新的', '角色日志');
            return false;
        }
        
        // 按楼层范围合并相同的更新
        const rangeMap = new Map();
        for (const range of updateRanges) {
            const key = `${range.startFloor}-${range.endFloor}`;
            if (!rangeMap.has(key)) {
                rangeMap.set(key, range);
            } else if (range.characters) {
                const existing = rangeMap.get(key);
                if (existing.characters) {
                    existing.characters.push(...range.characters);
                }
            }
        }
        
        // 执行更新
        let totalSuccessCount = 0;
        for (const range of rangeMap.values()) {
            console.log(`[角色日志] 更新范围: ${range.startFloor}-${range.endFloor}楼`, 
                        range.characters ? `角色: ${range.characters.join(', ')}` : '自动识别角色');
            
            // 传递range对象，其中可能包含existingCharacters信息
            const journals = await generateCharacterJournals(range.startFloor, range.endFloor, range);
            
            if (!journals || journals.size === 0) {
                console.log('[角色日志] 该范围未生成任何日志');
                continue;
            }
            
            // 更新每个角色的日志条目
            for (const [charName, journalContent] of journals.entries()) {
                const success = await updateCharacterJournal(charName, journalContent, range.startFloor, range.endFloor);
                if (success) {
                    totalSuccessCount++;
                }
            }
        }
        
        if (totalSuccessCount > 0) {
            toastr.success(`成功更新了 ${totalSuccessCount} 个角色的日志`, '角色日志');
            await updateStatus();
            return true;
        } else {
            toastr.warning('未能生成任何日志', '角色日志');
            return false;
        }
    } catch (error) {
        console.error('[角色日志] 执行更新失败:', error);
        toastr.error(`更新失败: ${error.message}`, '角色日志');
        return false;
    }
}

// 更新状态显示
async function updateStatus() {
    const settings = extension_settings[extensionName];
    const context = getContext();
    
    if (!context.chat) {
        $('#cj_status_display').html('未加载对话');
        $('#detected_characters_display').html('<span style="color: #999;">AI将在更新时识别角色</span>');
        return;
    }
    
    try {
        const lorebookName = await getTargetLorebookName();
        const totalMessages = context.chat.length;
        
        // 从世界书中读取已存在的角色日志
        let trackedCharacters = [];
        try {
            const bookData = await loadWorldInfo(lorebookName);
            if (bookData && bookData.entries) {
                const journalEntries = Object.values(bookData.entries).filter(
                    e => e.comment && e.comment.startsWith(JOURNAL_COMMENT_PREFIX) && !e.disable
                );
                
                trackedCharacters = journalEntries.map(entry => {
                    const charName = entry.comment.replace(JOURNAL_COMMENT_PREFIX, '');
                    return { name: charName };
                });
            }
        } catch (error) {
            console.log('[角色日志] 无法读取世界书');
        }
        
        // 更新检测到的角色显示
        if (trackedCharacters.length > 0) {
            const charBadges = trackedCharacters.map(c => 
                `<span class="character-badge detected">${c.name}</span>`
            ).join('');
            $('#detected_characters_display').html(charBadges);
        } else {
            $('#detected_characters_display').html('<span style="color: #999;">AI将在更新时识别角色</span>');
        }
        
        let statusHtml = `
            <strong>当前状态：</strong><br>
            • 功能状态: ${settings.enabled ? '✓ 已启用' : '✗ 未启用'}<br>
            • 世界书: ${lorebookName}<br>
            • 对话长度: ${totalMessages} 楼<br>
            • 跟踪角色数: ${trackedCharacters.length}<br>
            <br>
            <strong>📊 各角色进度：</strong><br>
        `;
        
        if (trackedCharacters.length > 0) {
            for (const char of trackedCharacters) {
                const progress = await readJournalProgress(lorebookName, char.name);
                const percentage = totalMessages > 0 ? Math.round((progress / totalMessages) * 100) : 0;
                statusHtml += `• ${char.name}: ${progress}/${totalMessages} 楼 (${percentage}%)<br>`;
            }
        } else {
            statusHtml += `<span style="color: #999;">暂无角色日志，点击"手动更新"开始</span><br>`;
        }
        
        $('#cj_status_display').html(statusHtml);
    } catch (error) {
        console.error('[角色日志] 更新状态失败:', error);
        $('#cj_status_display').html(`
            <strong>当前状态：</strong><br>
            • 功能状态: ${settings.enabled ? '✓ 已启用' : '✗ 未启用'}<br>
            • 对话长度: ${context.chat.length} 条消息<br>
            <br>
            <span style="color: #e74c3c;">⚠️ 无法读取详细状态: ${error.message}</span>
        `);
    }
}

// 加载设置
function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = defaultSettings;
    }
    
    const settings = extension_settings[extensionName];
    
    $('#cj_enabled').prop('checked', settings.enabled);
    $('#cj_target').val(settings.target);
    $('#cj_dedicated_worldbook').val(settings.dedicatedWorldbook || '');
    $('#cj_detection_mode').val(settings.detectionMode);
    $('#cj_manual_characters').val(settings.manualCharacters);
    $('#cj_exclude_names').val(settings.excludeNames || '');
    $('#cj_exclude_user').prop('checked', settings.excludeUser);
    $('#cj_use_worldinfo').prop('checked', settings.useWorldInfo);
    
    // 根据target值显示/隐藏专用世界书字段
    if (settings.target === 'dedicated') {
        $('#cj_dedicated_worldbook_field').show();
    } else {
        $('#cj_dedicated_worldbook_field').hide();
    }
    
    $('#cj_update_threshold').val(settings.updateThreshold);
    $('#cj_journal_prompt').val(settings.journalPrompt);
    
    $('#cj_auto_refine').prop('checked', settings.autoRefine);
    $('#cj_refine_threshold').val(settings.refineThreshold);
    $('#cj_keep_recent').val(settings.keepRecent);
    $('#cj_refine_prompt').val(settings.refinePrompt);
    
    $('#cj_keywords_template').val(settings.keywordsTemplate);
    $('#cj_insertion_position').val(settings.insertionPosition);
    $('#cj_entry_order').val(settings.entryOrder);
    $('#cj_depth').val(settings.depth);
    
    $('#cj_api_url').val(settings.api.url);
    $('#cj_api_key').val(settings.api.key);
    $('#cj_api_model').val(settings.api.model);
    $('#cj_api_max_tokens').val(settings.api.maxTokens);
    
    updateStatus();
}

// 保存设置
function saveSettings() {
    const settings = extension_settings[extensionName];
    
    settings.enabled = $('#cj_enabled').prop('checked');
    settings.target = $('#cj_target').val();
    settings.dedicatedWorldbook = $('#cj_dedicated_worldbook').val();
    settings.detectionMode = $('#cj_detection_mode').val();
    settings.manualCharacters = $('#cj_manual_characters').val();
    settings.excludeNames = $('#cj_exclude_names').val();
    settings.excludeUser = $('#cj_exclude_user').prop('checked');
    settings.useWorldInfo = $('#cj_use_worldinfo').prop('checked');
    
    settings.updateThreshold = parseInt($('#cj_update_threshold').val());
    settings.journalPrompt = $('#cj_journal_prompt').val();
    
    settings.autoRefine = $('#cj_auto_refine').prop('checked');
    settings.refineThreshold = parseInt($('#cj_refine_threshold').val());
    settings.keepRecent = parseInt($('#cj_keep_recent').val());
    settings.refinePrompt = $('#cj_refine_prompt').val();
    
    settings.keywordsTemplate = $('#cj_keywords_template').val();
    settings.insertionPosition = parseInt($('#cj_insertion_position').val());
    settings.entryOrder = parseInt($('#cj_entry_order').val());
    settings.depth = parseInt($('#cj_depth').val());
    
    settings.api.url = $('#cj_api_url').val();
    settings.api.key = $('#cj_api_key').val();
    settings.api.model = $('#cj_api_model').val();
    settings.api.maxTokens = parseInt($('#cj_api_max_tokens').val());
    
    saveSettingsDebounced();
    updateStatus();
}

// 测试API连接
async function testAPIConnection() {
    const apiUrl = $('#cj_api_url').val().trim();
    const apiKey = $('#cj_api_key').val().trim();
    const statusDiv = $('#cj_api_status');
    
    statusDiv.show().html('🔄 正在测试连接...').css('color', '#4a90e2');
    
    try {
        if (!apiUrl) {
            statusDiv.html('⚠️ 请先填写API地址').css('color', '#e74c3c');
            return;
        }
        
        let modelsUrl = apiUrl;
        if (!modelsUrl.endsWith('/v1/models')) {
            if (modelsUrl.endsWith('/')) {
                modelsUrl = modelsUrl.slice(0, -1);
            }
            if (modelsUrl.endsWith('/v1')) {
                modelsUrl += '/models';
            } else if (modelsUrl.endsWith('/v1/chat/completions')) {
                modelsUrl = modelsUrl.replace('/v1/chat/completions', '/v1/models');
            } else {
                modelsUrl += '/v1/models';
            }
        }
        
        const response = await fetch(modelsUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        const modelCount = data.data ? data.data.length : 0;
        
        statusDiv.html(`✓ 连接成功！找到 ${modelCount} 个模型`).css('color', '#27ae60');
        toastr.success('API连接测试成功', '角色日志');
        
        setTimeout(() => {
            statusDiv.fadeOut();
        }, 3000);
    } catch (error) {
        console.error('[角色日志] 测试连接失败:', error);
        statusDiv.html(`✗ 连接失败: ${error.message}`).css('color', '#e74c3c');
        toastr.error(`连接失败: ${error.message}`, '角色日志');
    }
}

// 拉取模型列表
async function fetchModels() {
    const apiUrl = $('#cj_api_url').val().trim();
    const apiKey = $('#cj_api_key').val().trim();
    const modelInput = $('#cj_api_model');
    
    if (!apiUrl) {
        toastr.warning('请先填写API地址', '角色日志');
        return;
    }
    
    const btn = $('#cj_fetch_models');
    btn.prop('disabled', true).text('拉取中...');
    
    try {
        let modelsUrl = apiUrl;
        if (!modelsUrl.endsWith('/v1/models')) {
            if (modelsUrl.endsWith('/')) {
                modelsUrl = modelsUrl.slice(0, -1);
            }
            if (modelsUrl.endsWith('/v1')) {
                modelsUrl += '/models';
            } else if (modelsUrl.endsWith('/v1/chat/completions')) {
                modelsUrl = modelsUrl.replace('/v1/chat/completions', '/v1/models');
            } else {
                modelsUrl += '/v1/models';
            }
        }
        
        console.log('[角色日志] 拉取模型列表:', modelsUrl);
        
        const response = await fetch(modelsUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        
        if (!data.data || data.data.length === 0) {
            toastr.warning('未找到可用模型', '角色日志');
            return;
        }
        
        // 创建模型选择对话框
        const models = data.data.map(m => m.id || m.model || m.name).filter(Boolean);
        console.log('[角色日志] 找到模型:', models);
        
        const modalHtml = `
            <div class="character-journal-modal" id="model_select_modal">
                <div class="character-journal-modal-content" style="max-width: 600px;">
                    <div class="character-journal-modal-header">
                        <h2>选择模型</h2>
                    </div>
                    <div class="character-journal-modal-body">
                        <div style="max-height: 400px; overflow-y: auto;">
                            ${models.map(model => `
                                <div class="character-list-item" style="cursor: pointer; padding: 12px;" data-model="${model}">
                                    <span style="flex: 1; color: #212121;">${model}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                    <div class="character-journal-modal-footer">
                        <button class="character-journal-btn" id="close_model_modal">取消</button>
                    </div>
                </div>
            </div>
        `;
        
        $('body').append(modalHtml);
        
        // 点击模型项选择
        $('.character-list-item[data-model]').on('click', function() {
            const selectedModel = $(this).attr('data-model');
            modelInput.val(selectedModel);
            $('#model_select_modal').remove();
            toastr.success(`已选择模型: ${selectedModel}`, '角色日志');
        });
        
        // 关闭按钮
        $('#close_model_modal').on('click', function() {
            $('#model_select_modal').remove();
        });
        
        // 点击背景关闭
        $('#model_select_modal').on('click', function(e) {
            if (e.target.id === 'model_select_modal') {
                $(this).remove();
            }
        });
        
        toastr.success(`找到 ${models.length} 个模型`, '角色日志');
        
    } catch (error) {
        console.error('[角色日志] 拉取模型失败:', error);
        toastr.error(`拉取模型失败: ${error.message}`, '角色日志');
    } finally {
        btn.prop('disabled', false).text('📋 拉取模型');
    }
}

// 手动精炼所有日志
async function refineAllJournals() {
    if (!confirm('确定要精炼所有角色的日志吗？这会将旧日志归档并压缩。')) {
        return;
    }
    
    try {
        const lorebookName = await getTargetLorebookName();
        const bookData = await loadWorldInfo(lorebookName);
        
        if (!bookData || !bookData.entries) {
            toastr.info('没有找到日志条目', '角色日志');
            return;
        }
        
        // 找出所有日志条目
        const journalEntries = Object.values(bookData.entries).filter(
            e => e.comment && e.comment.startsWith(JOURNAL_COMMENT_PREFIX) && !e.disable
        );
        
        if (journalEntries.length === 0) {
            toastr.info('没有找到需要精炼的日志', '角色日志');
            return;
        }
        
        toastr.info(`开始精炼 ${journalEntries.length} 个角色的日志...`, '角色日志');
        
        let successCount = 0;
        for (const entry of journalEntries) {
            const characterName = entry.comment.replace(JOURNAL_COMMENT_PREFIX, '');
            const success = await refineCharacterJournal(characterName, lorebookName);
            if (success) {
                successCount++;
            }
        }
        
        if (successCount > 0) {
            toastr.success(`成功精炼了 ${successCount} 个角色的日志`, '角色日志');
            await updateStatus();
        } else {
            toastr.warning('没有角色日志需要精炼或所有精炼都失败了', '角色日志');
        }
    } catch (error) {
        console.error('[角色日志] 批量精炼失败:', error);
        toastr.error(`批量精炼失败: ${error.message}`, '角色日志');
    }
}

// 精炼单个角色的日志
async function refineCharacterJournal(characterName, lorebookName) {
    const settings = extension_settings[extensionName];
    
    try {
        const bookData = await loadWorldInfo(lorebookName);
        if (!bookData || !bookData.entries) {
            toastr.error('无法读取世界书', '角色日志');
            return false;
        }
        
        // 找到该角色的日志条目
        const journalComment = `${JOURNAL_COMMENT_PREFIX}${characterName}`;
        const journalEntry = Object.values(bookData.entries).find(
            e => e.comment === journalComment && !e.disable
        );
        
        if (!journalEntry) {
            toastr.warning(`未找到${characterName}的日志条目`, '角色日志');
            return false;
        }
        
        // 提取内容
        const content = journalEntry.content;
        
        // 提取头部（角色名的第一人称日志记录：）
        const headerMatch = content.match(/^(.+?的第一人称日志记录：)/);
        const header = headerMatch ? headerMatch[1] : `${characterName}的第一人称日志记录：`;
        
        // 移除头部，获取所有日志内容（包括可能已存在的精炼摘要）
        let contentWithoutHeader = content.replace(/^.+?的第一人称日志记录：\s*/, '');
        
        // 移除进度封印
        contentWithoutHeader = contentWithoutHeader.replace(PROGRESS_SEAL_REGEX, '').trim();
        
        // 检查是否为空或内容太少
        if (!contentWithoutHeader || contentWithoutHeader.length < 100) {
            toastr.info(`${characterName}的日志内容太少，无需精炼`, '角色日志');
            return false;
        }
        
        // 调用AI精炼所有内容
        const refineMessages = [
            { role: 'system', content: settings.refinePrompt },
            { role: 'user', content: `角色名: ${characterName}\n\n需要精炼的日志:\n${contentWithoutHeader}` }
        ];
        
        console.log(`[角色日志] 精炼${characterName}的日志，内容长度: ${contentWithoutHeader.length}`);
        toastr.info(`正在精炼${characterName}的日志...`, '角色日志');
        
        const refinedSummary = await callAI(refineMessages);
        
        if (!refinedSummary) {
            toastr.error(`精炼${characterName}的日志失败`, '角色日志');
            return false;
        }
        
        // 获取当前进度（从原内容中提取）
        const progressMatch = content.match(PROGRESS_SEAL_REGEX);
        const currentProgress = progressMatch ? progressMatch[1] : '0';
        
        // 用精炼摘要覆盖原内容
        journalEntry.content = `${header}\n\n【精炼摘要】\n${refinedSummary}\n\n【已更新至第 ${currentProgress} 楼】`;
        
        // 保存世界书
        await saveWorldInfo(lorebookName, bookData, true);
        
        console.log(`[角色日志] ${characterName}的日志精炼完成`);
        toastr.success(`${characterName}的日志已精炼为摘要`, '角色日志');
        
        return true;
    } catch (error) {
        console.error(`[角色日志] 精炼${characterName}的日志失败:`, error);
        toastr.error(`精炼失败: ${error.message}`, '角色日志');
        return false;
    }
}

// 清空所有日志条目
async function clearAllJournals() {
    if (!confirm('确定要清空所有角色日志和归档条目吗？此操作不可恢复！')) {
        return;
    }
    
    try {
        const lorebookName = await getTargetLorebookName();
        const bookData = await loadWorldInfo(lorebookName);
        
        if (!bookData || !bookData.entries) {
            toastr.info('没有找到日志条目', '角色日志');
            return;
        }
        
        // 找出所有日志条目和归档条目
        let deletedCount = 0;
        const entriesToDelete = [];
        
        for (const [key, entry] of Object.entries(bookData.entries)) {
            if (entry.comment && 
                (entry.comment.startsWith(JOURNAL_COMMENT_PREFIX) || 
                 entry.comment.startsWith(ARCHIVE_COMMENT_PREFIX))) {
                entriesToDelete.push(key);
            }
        }
        
        // 删除条目
        for (const key of entriesToDelete) {
            delete bookData.entries[key];
            deletedCount++;
        }
        
        if (deletedCount > 0) {
            await saveWorldInfo(lorebookName, bookData, true);
            toastr.success(`已清空 ${deletedCount} 个条目（包括日志和归档）`, '角色日志');
            await updateStatus();
        } else {
            toastr.info('没有找到日志条目', '角色日志');
        }
    } catch (error) {
        console.error('[角色日志] 清空日志失败:', error);
        toastr.error(`清空失败: ${error.message}`, '角色日志');
    }
}

// 批量更新指定范围
async function batchUpdateRange() {
    const context = getContext();
    const settings = extension_settings[extensionName];
    
    if (!context.chat || context.chat.length === 0) {
        toastr.warning('当前没有对话', '角色日志');
        return;
    }
    
    const totalMessages = context.chat.length;
    
    // 创建输入对话框
    const modalHtml = `
        <div class="character-journal-modal" id="batch_update_modal">
            <div class="character-journal-modal-content" style="max-width: 500px;">
                <div class="character-journal-modal-header">
                    <h2>📦 批量更新日志</h2>
                </div>
                <div class="character-journal-modal-body">
                    <div class="character-journal-info" style="margin-bottom: 15px;">
                        <strong>当前对话总长度：</strong> ${totalMessages} 楼<br>
                        <strong>更新阈值：</strong> ${settings.updateThreshold} 楼/次
                    </div>
                    
                    <div class="character-journal-field">
                        <label for="batch_start_floor">起始楼层：</label>
                        <input type="number" id="batch_start_floor" min="1" max="${totalMessages}" value="1" style="width: 100%;">
                    </div>
                    
                    <div class="character-journal-field">
                        <label for="batch_end_floor">结束楼层：</label>
                        <input type="number" id="batch_end_floor" min="1" max="${totalMessages}" value="${totalMessages}" style="width: 100%;">
                    </div>
                    
                    <div class="character-journal-info" style="margin-top: 15px; padding: 10px; background: #fff3cd; border-radius: 4px;">
                        <strong>⚠️ 注意：</strong><br>
                        • 程序会按阈值自动分批更新<br>
                        • 例如：2-250楼，阈值20，会分成多次调用API<br>
                        • 已有进度的角色会自动跳过已更新部分
                    </div>
                    
                    <div id="batch_progress_display" style="margin-top: 15px; display: none;">
                        <div style="font-weight: bold; margin-bottom: 8px;">更新进度：</div>
                        <div id="batch_progress_bar" style="width: 100%; height: 24px; background: #e0e0e0; border-radius: 12px; overflow: hidden; position: relative;">
                            <div id="batch_progress_fill" style="height: 100%; background: linear-gradient(90deg, #4a90e2, #357abd); transition: width 0.3s; width: 0%;"></div>
                            <div id="batch_progress_text" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 12px; font-weight: bold; color: #fff;">0%</div>
                        </div>
                        <div id="batch_progress_info" style="margin-top: 8px; font-size: 13px; color: #666;"></div>
                    </div>
                </div>
                <div class="character-journal-modal-footer">
                    <button class="character-journal-btn" id="cancel_batch_update">取消</button>
                    <button class="character-journal-btn success" id="start_batch_update">开始更新</button>
                </div>
            </div>
        </div>
    `;
    
    $('body').append(modalHtml);
    
    let isUpdating = false;
    
    // 开始更新按钮
    $('#start_batch_update').on('click', async function() {
        if (isUpdating) return;
        
        const startFloor = parseInt($('#batch_start_floor').val());
        const endFloor = parseInt($('#batch_end_floor').val());
        
        if (isNaN(startFloor) || isNaN(endFloor)) {
            toastr.error('请输入有效的楼层数字', '角色日志');
            return;
        }
        
        if (startFloor < 1 || endFloor > totalMessages) {
            toastr.error(`楼层范围必须在 1-${totalMessages} 之间`, '角色日志');
            return;
        }
        
        if (startFloor > endFloor) {
            toastr.error('起始楼层不能大于结束楼层', '角色日志');
            return;
        }
        
        isUpdating = true;
        $('#start_batch_update').prop('disabled', true).text('更新中...');
        $('#cancel_batch_update').prop('disabled', true);
        $('#batch_progress_display').show();
        
        try {
            await executeBatchUpdate(startFloor, endFloor);
            toastr.success('批量更新完成！', '角色日志');
            $('#batch_update_modal').remove();
            await updateStatus();
        } catch (error) {
            console.error('[角色日志] 批量更新失败:', error);
            toastr.error(`批量更新失败: ${error.message}`, '角色日志');
            $('#start_batch_update').prop('disabled', false).text('开始更新');
            $('#cancel_batch_update').prop('disabled', false);
        } finally {
            isUpdating = false;
        }
    });
    
    // 取消按钮
    $('#cancel_batch_update').on('click', function() {
        if (!isUpdating) {
            $('#batch_update_modal').remove();
        }
    });
    
    // 点击背景关闭（仅在未更新时）
    $('#batch_update_modal').on('click', function(e) {
        if (e.target.id === 'batch_update_modal' && !isUpdating) {
            $(this).remove();
        }
    });
}

// 执行批量更新
async function executeBatchUpdate(startFloor, endFloor) {
    const settings = extension_settings[extensionName];
    const threshold = settings.updateThreshold;
    const lorebookName = await getTargetLorebookName();
    
    // 读取所有角色的当前进度
    const characterProgresses = new Map();
    try {
        const bookData = await loadWorldInfo(lorebookName);
        if (bookData && bookData.entries) {
            const journalEntries = Object.values(bookData.entries).filter(
                e => e.comment && e.comment.startsWith(JOURNAL_COMMENT_PREFIX) && !e.disable
            );
            
            for (const entry of journalEntries) {
                const charName = entry.comment.replace(JOURNAL_COMMENT_PREFIX, '');
                const match = entry.content.match(PROGRESS_SEAL_REGEX);
                const progress = match ? parseInt(match[1], 10) : 0;
                characterProgresses.set(charName, progress);
            }
        }
    } catch (error) {
        console.log('[角色日志] 无法读取现有进度，将从头开始');
    }
    
    // 计算需要更新的批次
    const batches = [];
    let currentFloor = startFloor;
    
    while (currentFloor <= endFloor) {
        const batchEnd = Math.min(currentFloor + threshold - 1, endFloor);
        batches.push({
            start: currentFloor,
            end: batchEnd
        });
        currentFloor = batchEnd + 1;
    }
    
    console.log(`[角色日志] 批量更新: ${startFloor}-${endFloor}楼, 共${batches.length}批次`);
    
    let completedBatches = 0;
    const totalBatches = batches.length;
    
    // 更新进度显示
    function updateProgress(current, total, info) {
        const percentage = Math.round((current / total) * 100);
        $('#batch_progress_fill').css('width', `${percentage}%`);
        $('#batch_progress_text').text(`${percentage}%`);
        $('#batch_progress_info').html(info);
    }
    
    // 为每个批次更新日志
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const batchInfo = `批次 ${i + 1}/${totalBatches}: 第${batch.start}-${batch.end}楼`;
        
        console.log(`[角色日志] ${batchInfo}`);
        updateProgress(i, totalBatches, `${batchInfo}<br>正在生成日志...`);
        
        // 确定本批次需要更新的角色
        let updateRanges = [];
        
        if (characterProgresses.size > 0) {
            // 有已存在的角色，检查每个角色的进度
            for (const [charName, progress] of characterProgresses.entries()) {
                // 如果该角色的进度小于本批次的起始楼层，需要更新
                if (progress < batch.end) {
                    const charStartFloor = Math.max(progress + 1, batch.start);
                    if (charStartFloor <= batch.end) {
                        updateRanges.push({
                            characters: [charName],
                            startFloor: charStartFloor,
                            endFloor: batch.end,
                            isExisting: true
                        });
                    }
                }
            }
            
            // 在每个批次中识别新角色
            updateRanges.push({
                characters: null, // AI自动识别
                startFloor: batch.start,
                endFloor: batch.end,
                isExisting: false,
                existingCharacters: Array.from(characterProgresses.keys())
            });
        } else {
            // 没有任何角色，从头识别
            updateRanges.push({
                characters: null,
                startFloor: batch.start,
                endFloor: batch.end,
                isExisting: false
            });
        }
        
        // 生成日志
        for (const range of updateRanges) {
            const journals = await generateCharacterJournals(range.startFloor, range.endFloor, range);
            
            if (!journals || journals.size === 0) {
                continue;
            }
            
            // 更新每个角色的日志
            for (const [charName, journalContent] of journals.entries()) {
                await updateCharacterJournal(charName, journalContent, range.startFloor, range.endFloor);
                
                // 更新进度映射
                characterProgresses.set(charName, range.endFloor);
            }
        }
        
        completedBatches++;
        updateProgress(completedBatches, totalBatches, `✓ 已完成 ${completedBatches}/${totalBatches} 批次`);
        
        // 短暂延迟避免API限流
        if (i < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    console.log('[角色日志] 批量更新全部完成');
}

// 设置UI事件监听
function setupUIHandlers() {
    // 保存设置按钮
    $('#cj_save_settings').on('click', function() {
        saveSettings();
        toastr.success('设置已保存', '角色日志');
    });
    
    // 测试连接按钮
    $('#cj_test_api').on('click', testAPIConnection);
    
    // 拉取模型按钮
    $('#cj_fetch_models').on('click', fetchModels);
    
    // 手动更新按钮
    $('#cj_manual_update').on('click', async function() {
        await executeJournalUpdate();
    });
    
    // 批量更新按钮
    $('#cj_batch_update').on('click', async function() {
        await batchUpdateRange();
    });
    
    // 手动精炼按钮
    $('#cj_manual_refine').on('click', async function() {
        await refineAllJournals();
    });
    
    // 清空日志按钮
    $('#cj_clear_all').on('click', async function() {
        await clearAllJournals();
    });
    
    // 检测模式改变时更新显示
    $('#cj_detection_mode').on('change', function() {
        updateStatus();
    });
    
    $('#cj_manual_characters').on('input', function() {
        if ($('#cj_detection_mode').val() === 'manual') {
            updateStatus();
        }
    });
    
    // 目标世界书改变时显示/隐藏专用世界书字段
    $('#cj_target').on('change', function() {
        if ($(this).val() === 'dedicated') {
            $('#cj_dedicated_worldbook_field').slideDown();
        } else {
            $('#cj_dedicated_worldbook_field').slideUp();
        }
        updateStatus();
    });
    
    // 选择现有世界书按钮
    $('#cj_select_worldbook').on('click', selectWorldbook);
}

// 选择现有世界书
async function selectWorldbook() {
    try {
        // 动态导入 world_names
        const { world_names } = await import('/scripts/world-info.js');
        
        if (!world_names || world_names.length === 0) {
            toastr.info('没有找到世界书', '角色日志');
            return;
        }
        
        // 处理世界书名称（去除.json后缀）
        const worldbooks = world_names.map(filename => {
            return filename.replace('.json', '');
        });
        
        console.log('[角色日志] 找到世界书:', worldbooks);
        
        // 创建世界书选择对话框
        const modalHtml = `
            <div class="character-journal-modal" id="worldbook_select_modal">
                <div class="character-journal-modal-content" style="max-width: 600px;">
                    <div class="character-journal-modal-header">
                        <h2>选择世界书</h2>
                    </div>
                    <div class="character-journal-modal-body">
                        <div style="max-height: 400px; overflow-y: auto;">
                            ${worldbooks.map(wb => `
                                <div class="character-list-item" style="cursor: pointer; padding: 12px;" data-worldbook="${wb}">
                                    <span style="flex: 1; color: #212121;">📚 ${wb}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                    <div class="character-journal-modal-footer">
                        <button class="character-journal-btn" id="close_worldbook_modal">取消</button>
                    </div>
                </div>
            </div>
        `;
        
        $('body').append(modalHtml);
        
        // 点击世界书项选择
        $('.character-list-item[data-worldbook]').on('click', function() {
            const selectedWorldbook = $(this).attr('data-worldbook');
            $('#cj_dedicated_worldbook').val(selectedWorldbook);
            $('#worldbook_select_modal').remove();
            toastr.success(`已选择世界书: ${selectedWorldbook}`, '角色日志');
        });
        
        // 关闭按钮
        $('#close_worldbook_modal').on('click', function() {
            $('#worldbook_select_modal').remove();
        });
        
        // 点击背景关闭
        $('#worldbook_select_modal').on('click', function(e) {
            if (e.target.id === 'worldbook_select_modal') {
                $(this).remove();
            }
        });
        
    } catch (error) {
        console.error('[角色日志] 选择世界书失败:', error);
        toastr.error(`选择世界书失败: ${error.message}`, '角色日志');
    }
}

// 初始化扩展
jQuery(async () => {
    const settingsHtml = await $.get(`${extensionFolderPath}settings.html`);
    const settingsCss = await $.get(`${extensionFolderPath}style.css`);
    
    // 注入样式
    $('<style>').text(settingsCss).appendTo('head');
    
    // 创建扩展面板
    const extensionPanel = $(`
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>📖 角色日志系统</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                ${settingsHtml}
            </div>
        </div>
    `);
    
    $('#extensions_settings2').append(extensionPanel);
    
    // 加载设置
    loadSettings();
    
    // 设置事件监听
    setupUIHandlers();
    
    // 监听聊天消息事件
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        const settings = extension_settings[extensionName];
        if (settings.enabled) {
            // 这里可以添加自动触发逻辑
            updateStatus();
        }
    });
    
    eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
        updateStatus();
    });
    
    console.log('[角色日志系统] 扩展已加载');
});
