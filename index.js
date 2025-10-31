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
    detectionMode: "auto",
    manualCharacters: "",
    excludeNames: "",
    excludeUser: true,
    autoUpdate: false,
    useWorldInfo: true,
    
    updateThreshold: 20,
    journalPrompt: `你是记忆记录助手。请为每个角色写**多条**第一人称日志条目，每条记录一个独立的事件。

要求：
1. 使用第一人称（我、我的）
2. 每个事件独立成条，格式：时间标记 + 事件 + 感受/想法
3. 时间标记可以灵活使用：具体时间（早上/下午）、日期（某月某日）、节日（春节/中秋）、事件节点（XX事件前/中/后）等
4. 每条日志控制在50-100字左右
5. 一个角色可以有多条日志（取决于发生了多少事件）
6. 如果角色未出场，写：【本轮未出场】

输出格式示例：
===角色:炽霞===
• 早上巡逻时 - 遇到了杨，昨晚的事让我有些不知所措，但还是强装镇定。走路时身体还有些不适，希望他没注意到。
• 巡逻途中 - 听到呼救声，立刻切换到工作模式。杨跟了上来，虽然有些意外，但多个人手总是好的。
===角色:小系统===
• 清晨时分 - 一早就开始调侃宿主昨晚的"战绩"，看他窘迫的样子真有趣。
• 能量异常 - 检测到附近有异常能量波动，提醒宿主注意，可能有麻烦要来了。
===END===

禁止事项：
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
        const chatId = context.chatId || "unknown";
        return `CharacterJournal-${chatId}`;
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

// 获取未记录的消息
function getUnloggedMessages(startFloor, endFloor, characterName) {
    const context = getContext();
    const chat = context.chat;
    
    if (!chat || chat.length === 0) return [];
    
    const historySlice = chat.slice(startFloor - 1, endFloor);
    const userName = context.name1 || '用户';
    
    return historySlice.map((msg, index) => {
        const author = msg.is_user ? userName : (msg.name || context.name2 || '角色');
        return {
            floor: startFloor + index,
            author: author,
            content: msg.mes.trim(),
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
function parseCharacterJournals(response) {
    const journals = new Map();
    
    // 匹配格式: ===角色:Name===\n内容\n
    const regex = /===角色:([^=]+)===\s*\n([\s\S]*?)(?=\n===角色:|===END===|$)/g;
    let match;
    
    while ((match = regex.exec(response)) !== null) {
        const characterName = match[1].trim();
        const journalContent = match[2].trim();
        
        if (journalContent && !journalContent.includes('【本轮未出场】')) {
            journals.set(characterName, journalContent);
        }
    }
    
    return journals;
}

// AI识别角色
async function detectCharactersByAI(messages) {
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
async function generateCharacterJournals(startFloor, endFloor, characters) {
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
    
    if (settings.detectionMode === "manual" && settings.manualCharacters) {
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
        finalCharacters = await detectCharactersByAI(messages);
        
        if (!finalCharacters || finalCharacters.length === 0) {
            toastr.warning('AI未能识别到角色', '角色日志');
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
    
    const journals = parseCharacterJournals(response);
    console.log('[角色日志] 解析结果:', Array.from(journals.keys()));
    
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
        
        // 读取所有已存在的日志进度，找出最小值
        let minProgress = 0;
        try {
            const bookData = await loadWorldInfo(lorebookName);
            if (bookData && bookData.entries) {
                const journalEntries = Object.values(bookData.entries).filter(
                    e => e.comment && e.comment.startsWith(JOURNAL_COMMENT_PREFIX) && !e.disable
                );
                
                if (journalEntries.length > 0) {
                    minProgress = Infinity;
                    for (const entry of journalEntries) {
                        const match = entry.content.match(PROGRESS_SEAL_REGEX);
                        const progress = match ? parseInt(match[1], 10) : 0;
                        minProgress = Math.min(minProgress, progress);
                    }
                    if (minProgress === Infinity) {
                        minProgress = 0;
                    }
                }
            }
        } catch (error) {
            console.log('[角色日志] 无法读取现有进度，从头开始');
            minProgress = 0;
        }
        
        const startFloor = minProgress + 1;
        const endFloor = Math.min(minProgress + settings.updateThreshold, context.chat.length);
        
        if (startFloor > context.chat.length) {
            toastr.info('所有角色日志都是最新的', '角色日志');
            return false;
        }
        
        console.log(`[角色日志] 更新范围: ${startFloor}-${endFloor}楼`);
        
        // 生成所有角色的日志（AI会自动识别角色）
        const journals = await generateCharacterJournals(startFloor, endFloor, null);
        
        if (!journals || journals.size === 0) {
            toastr.warning('未能生成任何日志', '角色日志');
            return false;
        }
        
        // 更新每个角色的日志条目
        let successCount = 0;
        for (const [charName, journalContent] of journals.entries()) {
            const success = await updateCharacterJournal(charName, journalContent, startFloor, endFloor);
            if (success) {
                successCount++;
            }
        }
        
        if (successCount > 0) {
            toastr.success(`成功更新了 ${successCount} 个角色的日志`, '角色日志');
            await updateStatus();
            return true;
        } else {
            toastr.error('所有日志更新都失败了', '角色日志');
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
    $('#cj_detection_mode').val(settings.detectionMode);
    $('#cj_manual_characters').val(settings.manualCharacters);
    $('#cj_exclude_names').val(settings.excludeNames || '');
    $('#cj_exclude_user').prop('checked', settings.excludeUser);
    $('#cj_use_worldinfo').prop('checked', settings.useWorldInfo);
    
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
        
        // 提取所有日志段落（按分隔符拆分）
        const content = journalEntry.content;
        const sections = content.split(/---\n\n/).filter(s => s.trim());
        
        if (sections.length <= settings.keepRecent) {
            toastr.info(`${characterName}的日志条目数不足，无需精炼`, '角色日志');
            return false;
        }
        
        // 保留最近的N条日志
        const recentSections = sections.slice(-settings.keepRecent);
        
        // 需要归档的旧日志
        const oldSections = sections.slice(0, -settings.keepRecent);
        const oldContent = oldSections.join('\n---\n\n');
        
        // 调用AI精炼旧日志
        const refineMessages = [
            { role: 'system', content: settings.refinePrompt },
            { role: 'user', content: `角色名: ${characterName}\n\n需要精炼的日志:\n${oldContent}` }
        ];
        
        console.log(`[角色日志] 精炼${characterName}的旧日志，归档${oldSections.length}条，保留${recentSections.length}条`);
        const refinedArchive = await callAI(refineMessages);
        
        if (!refinedArchive) {
            toastr.error(`精炼${characterName}的日志失败`, '角色日志');
            return false;
        }
        
        // 创建归档条目
        const archiveKey = Date.now().toString() + '-archive-' + characterName;
        const archiveComment = `${ARCHIVE_COMMENT_PREFIX}${characterName}`;
        
        const archiveEntry = {
            uid: archiveKey,
            key: [`${characterName}档案`, `${characterName}过往`],
            keysecondary: [],
            comment: archiveComment,
            content: `${characterName}的精炼档案（归档）:\n\n${refinedArchive}`,
            constant: false,
            selective: true,
            selectiveLogic: 0,
            addMemo: false,
            order: parseInt(settings.entryOrder) - 10 || 80,
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
        
        bookData.entries[archiveKey] = archiveEntry;
        
        // 更新原日志条目，只保留最近的条目
        const headerMatch = content.match(/^(.+?的第一人称日志记录：)/);
        const header = headerMatch ? headerMatch[1] : `${characterName}的第一人称日志记录：`;
        
        journalEntry.content = header + '\n\n' + recentSections.join('\n---\n\n');
        
        // 保存世界书
        await saveWorldInfo(lorebookName, bookData, true);
        
        console.log(`[角色日志] ${characterName}的日志精炼完成`);
        toastr.success(`${characterName}的日志已精炼，归档了${oldSections.length}条旧日志`, '角色日志');
        
        return true;
    } catch (error) {
        console.error(`[角色日志] 精炼${characterName}的日志失败:`, error);
        toastr.error(`精炼失败: ${error.message}`, '角色日志');
        return false;
    }
}

// 清空所有日志条目
async function clearAllJournals() {
    if (!confirm('确定要清空所有角色日志条目吗？此操作不可恢复！')) {
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
        let deletedCount = 0;
        const entriesToDelete = [];
        
        for (const [key, entry] of Object.entries(bookData.entries)) {
            if (entry.comment && entry.comment.startsWith(JOURNAL_COMMENT_PREFIX)) {
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
            toastr.success(`已清空 ${deletedCount} 个日志条目`, '角色日志');
            await updateStatus();
        } else {
            toastr.info('没有找到日志条目', '角色日志');
        }
    } catch (error) {
        console.error('[角色日志] 清空日志失败:', error);
        toastr.error(`清空失败: ${error.message}`, '角色日志');
    }
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
