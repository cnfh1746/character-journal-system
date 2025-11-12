import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";
import { 
    loadWorldInfo, 
    saveWorldInfo,
    createNewWorldInfo,
    createWorldInfoEntry
} from "../../../world-info.js";
import { characters } from "../../../../script.js";

const extensionName = "character-journal-system";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}/`;

// 常量定义
const JOURNAL_COMMENT_PREFIX = "【日志】";
const ARCHIVE_COMMENT_PREFIX = "【归档】";
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
    
    // 智能过滤设置
    filterEnabled: true,
    minAppearances: 5,
    
    updateThreshold: 20,
    journalPrompt: `你是记忆记录助手。我会提供一些名字和它们的世界书资料，请根据资料和对话记录判断哪些是**实际的角色**并为其生成第一人称日志。

🔴 核心判断规则：
1. **根据世界书资料判断是否为角色实体**：
   - 如果资料描述的是人物（有性别、性格、经历等），则为角色
   - 如果资料描述的是地点、组织、物品等，直接跳过
   - 如果没有世界书资料，根据对话内容判断（有对话/行动描写的才算角色）

2. **性别筛选**：
   - 只为女性角色生成日志
   - 如果世界书资料显示是男性，直接跳过
   - 如果资料未明确性别，根据对话中的代词/称呼判断

3. **出场判断**：
   - 只为**在本轮对话中实际出场**的角色生成日志
   - 实际出场 = 有明确的对话、行动或情感描写
   - 只是被提到名字但未出场的，直接跳过

4. **输出要求**：
   - 必须是第一人称日记形式（我、我的）
   - 每个事件独立成条：时间标记 - 事件 + 内心感受
   - 每条日志50-100字左右

✅ 正确示例：
===角色:炽霞===
• 早上巡逻时 - 遇到了杨，昨晚的事让我有些不知所措，但还是强装镇定。走路时身体还有些不适，希望他没注意到。
• 巡逻途中 - 听到呼救声，立刻切换到工作模式。杨跟了上来，虽然有些意外，但多个人手总是好的。
===角色:秧秧===
• 上午 - 继续照顾杨和炽霞，看着两人的互动觉得有些好笑。年轻人的感情总是这么青涩可爱。
===END===

❌ 要直接跳过的情况（不要输出任何内容）：
• 男性角色（资料显示性别为男）
• 地点/组织/物品（资料描述的不是人物）
• 未出场角色（只是被提到但无实际行动）
• 无法判断的实体（既无资料也无出场描写）`,
    
        autoRefine: false,
        refineThreshold: 5000,
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


// 获取目标世界书名称（智能切换版）
async function getTargetLorebookName() {
    const settings = extension_settings[extensionName];
    const context = getContext();
    
    if (settings.target === "dedicated") {
        // 专用世界书模式：使用用户指定的固定世界书
        if (settings.dedicatedWorldbook && settings.dedicatedWorldbook.trim()) {
            return settings.dedicatedWorldbook.trim();
        } else {
            const chatId = context.chatId || "unknown";
            return `CharacterJournal-${chatId}`;
        }
    }
    
    // character_main 模式：根据角色名自动生成世界书
    const charName = context.name2 || "角色";
    const worldbookName = `${charName}日志`;
    
    console.log(`[角色日志] 当前角色: ${charName}, 目标世界书: ${worldbookName}`);
    
    // 检查世界书是否存在
    try {
        await loadWorldInfo(worldbookName);
        console.log(`[角色日志] ✓ 找到世界书: ${worldbookName}`);
    } catch (error) {
        // 世界书不存在，让 TavernHelper 来处理创建和绑定
        console.log(`[角色日志] ✗ 世界书不存在，调用 TavernHelper.getOrCreateChatLorebook 创建并绑定: ${worldbookName}`);
        try {
            // 【核心修改】一步到位，创建、绑定、刷新UI
            await TavernHelper.getOrCreateChatLorebook(worldbookName);
            
            console.log(`[角色日志] ✓ 成功创建并绑定世界书: ${worldbookName}`);
            toastr.success(`已自动创建并绑定世界书: ${worldbookName}`, '角色日志');

            // 【关键】在TavernHelper操作后，手动刷新一下列表以确保万无一失
            if (SillyTavern.worldInfo && typeof SillyTavern.worldInfo.refreshWorldInfoList === 'function') {
                await SillyTavern.worldInfo.refreshWorldInfoList();
                console.log('[角色日志] ✓ 已调用 worldInfo.refreshWorldInfoList() 刷新列表');
            }

        } catch (createError) {
            console.error(`[角色日志] ✗ 使用 TavernHelper 创建/绑定世界书失败:`, createError);
            toastr.error(`创建/绑定世界书失败: ${createError.message}`, '角色日志');
        }
    }
    
    return worldbookName;
}

// 读取角色日志进度
async function readJournalProgress(lorebookName, characterName) {
    try {
        const bookData = await loadWorldInfo(lorebookName);
        if (!bookData || !bookData.entries) {
            console.log(`[角色日志] ${characterName}: 世界书无数据`);
            return 0;
        }
        
        const journalEntry = Object.values(bookData.entries).find(
            e => e.comment === `${JOURNAL_COMMENT_PREFIX}${characterName}` && !e.disable
        );
        
        if (!journalEntry) {
            console.log(`[角色日志] ${characterName}: 未找到条目 (comment应为: ${JOURNAL_COMMENT_PREFIX}${characterName})`);
            return 0;
        }
        
        console.log(`[角色日志] ${characterName}: 找到条目，content长度=${journalEntry.content.length}`);
        console.log(`[角色日志] ${characterName}: content末尾100字符:`, journalEntry.content.slice(-100));
        
        const match = journalEntry.content.match(PROGRESS_SEAL_REGEX);
        if (match) {
            console.log(`[角色日志] ${characterName}: 成功匹配进度 ${match[1]}楼`);
            return parseInt(match[1], 10);
        } else {
            console.log(`[角色日志] ${characterName}: ❌ 未匹配到进度封印，正则=${PROGRESS_SEAL_REGEX}`);
            return 0;
        }
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

// 辅助函数：延迟执行
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 调用AI生成日志（带重试机制）
async function callAI(messages, retryCount = 0) {
    const settings = extension_settings[extensionName];
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [5000, 10000, 20000]; // 5秒、10秒、20秒
    
    console.log('[角色日志] callAI开始', retryCount > 0 ? `(重试 ${retryCount}/${MAX_RETRIES})` : '');
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
                
                // 检查是否应该重试
                const shouldRetry = retryCount < MAX_RETRIES && (
                    response.status === 429 || // Too Many Requests
                    response.status === 500 || // Internal Server Error
                    response.status === 502 || // Bad Gateway
                    response.status === 503 || // Service Unavailable
                    response.status === 504    // Gateway Timeout
                );
                
                if (shouldRetry) {
                    const delay = RETRY_DELAYS[retryCount];
                    console.log(`[角色日志] 第${retryCount + 1}次尝试失败(${response.status})，${delay/1000}秒后重试...`);
                    toastr.warning(`API调用失败(${response.status})，${delay/1000}秒后重试(${retryCount + 1}/${MAX_RETRIES})...`, '角色日志', {timeOut: delay});
                    
                    await sleep(delay);
                    return await callAI(messages, retryCount + 1);
                }
                
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
            
            // 成功后提示（如果之前有重试）
            if (retryCount > 0) {
                toastr.success(`API调用成功(经过${retryCount}次重试)`, '角色日志');
            }
            
            return content;
        } catch (error) {
            // 网络错误也应该重试
            const isNetworkError = error.message.includes('fetch') || 
                                  error.message.includes('network') || 
                                  error.message.includes('timeout');
            
            if (isNetworkError && retryCount < MAX_RETRIES) {
                const delay = RETRY_DELAYS[retryCount];
                console.log(`[角色日志] 网络错误，${delay/1000}秒后重试(${retryCount + 1}/${MAX_RETRIES})...`);
                toastr.warning(`网络错误，${delay/1000}秒后重试(${retryCount + 1}/${MAX_RETRIES})...`, '角色日志', {timeOut: delay});
                
                await sleep(delay);
                return await callAI(messages, retryCount + 1);
            }
            
            console.error('[角色日志] API调用失败:', error);
            console.error('[角色日志] 错误堆栈:', error.stack);
            
            if (retryCount >= MAX_RETRIES) {
                toastr.error(`API调用失败(已重试${MAX_RETRIES}次): ${error.message}`, '角色日志');
            } else {
                toastr.error(`API调用失败: ${error.message}`, '角色日志');
            }
            
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
        // ST API也应该支持重试
        if (retryCount < MAX_RETRIES) {
            const delay = RETRY_DELAYS[retryCount];
            console.log(`[角色日志] ST API错误，${delay/1000}秒后重试(${retryCount + 1}/${MAX_RETRIES})...`);
            toastr.warning(`生成失败，${delay/1000}秒后重试(${retryCount + 1}/${MAX_RETRIES})...`, '角色日志', {timeOut: delay});
            
            await sleep(delay);
            return await callAI(messages, retryCount + 1);
        }
        
        console.error('[角色日志] 调用ST API失败:', error);
        console.error('[角色日志] 错误堆栈:', error.stack);
        toastr.error(`生成日志失败(已重试${MAX_RETRIES}次): ${error.message}`, '角色日志');
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

// 智能过滤角色（仅保留出场次数过滤）
async function filterCharacters(characters, messages) {
    const settings = extension_settings[extensionName];
    
    // 如果未启用过滤，直接返回
    if (!settings.filterEnabled) {
        console.log('[角色日志] 出场次数过滤已禁用');
        return characters;
    }
    
    // 如果最小出场次数为0，不过滤
    if (settings.minAppearances <= 0) {
        console.log('[角色日志] 最小出场次数为0，跳过过滤');
        return characters;
    }
    
    console.log(`[角色日志] 开始出场次数过滤，待过滤角色数: ${characters.length}`);
    
    const filtered = [];
    
    // 合并所有对话文本用于统计出场次数
    const fullChatText = messages.map(m => m.content).join('\n');
    
    for (const char of characters) {
        const charName = char.name || char;
        
        // 统计名字在对话中出现的次数
        const regex = new RegExp(charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        const matches = fullChatText.match(regex);
        const appearanceCount = matches ? matches.length : 0;
        
        if (appearanceCount < settings.minAppearances) {
            console.log(`[角色日志] ❌ 过滤角色: ${charName} - 出场次数不足(${appearanceCount}次 < ${settings.minAppearances}次)`);
        } else {
            console.log(`[角色日志] ✓ 保留角色: ${charName} (出现${appearanceCount}次)`);
            filtered.push(char);
        }
    }
    
    console.log(`[角色日志] 出场次数过滤完成: ${characters.length} -> ${filtered.length}`);
    return filtered;
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
    
    const detectPrompt = `你是角色识别助手。请分析以下对话记录，识别出**重要的女性角色名字**。

🔴 严格要求：
1. **只识别女性角色** - 绝对不要识别男性角色
2. **只识别重要角色** - 有实质性对话/行动的主要角色，不要识别：
   - 一笔带过的配角（如"阿布"、"黑咩"、"白咩"等）
   - 只是被提到但未实际出场的角色
   - 非人类角色（动物、怪物等）
3. **不要包含这些名字**：${excludeList.join('、')}
4. **绝对禁止识别**：
   - ❌ 地点名（如"今州"、"虹镇"、"京城"等）
   - ❌ 组织/势力名（如"鸣沙阁"、"巡查司"等）
   - ❌ 职位/称谓（如"巡查员"、"医女"等）
   - ❌ 物品/概念（如"任务"、"案件"等）
   - ❌ 世界名/国家名
5. **同一角色只输出一个名字**：
   - 如果角色有多个名字（大名、小名、外号），只输出最常用的大名
   - 例如："今汐"和"汐汐"是同一人，只输出"今汐"
6. 如果没有符合条件的角色，返回：无

💡 识别技巧：
- 真正的角色会有对话、行动、情感描写
- 地点名通常作为场景描述出现
- 组织名通常与"前往"、"属于"等动词连用

对话记录：
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
    
    console.log('[角色日志] AI识别到的角色:', detectedNames.join(', '));
    
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
    let isManualMode = false; // 标记是否为手动输入模式
    
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
        
        isManualMode = true; // 标记为手动模式
        console.log('[角色日志] 手动模式 - 使用用户指定的角色（不应用出场次数过滤）:', manualNames);
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
    
    // 🔧 统一应用出场次数过滤（手动模式除外）
    if (!isManualMode && settings.filterEnabled && settings.minAppearances > 0) {
        toastr.info('正在应用出场次数过滤...', '角色日志');
        
        const beforeCount = finalCharacters.length;
        finalCharacters = await filterCharacters(finalCharacters, messages);
        const afterCount = finalCharacters.length;
        
        if (afterCount < beforeCount) {
            console.log(`[角色日志] 出场次数过滤: ${beforeCount} -> ${afterCount} (过滤掉 ${beforeCount - afterCount} 个)`);
            toastr.info(`出场次数过滤: 保留 ${afterCount}/${beforeCount} 个角色`, '角色日志');
        }
        
        if (finalCharacters.length === 0) {
            console.log('[角色日志] 出场次数过滤后无剩余角色');
            toastr.warning('所有识别的角色都被过滤掉了（出场次数不足）', '角色日志');
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
                console.log(`[角色日志] 获取到${char.name}的资料:`, info.substring(0, 50) + '...');
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

// 检查并自动更新
async function checkAndAutoUpdate() {
    const settings = extension_settings[extensionName];
    const context = getContext();
    
    if (!context.chat || context.chat.length === 0) {
        return;
    }
    
    try {
        const lorebookName = await getTargetLorebookName();
        
        // 读取所有角色的进度
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
            console.log('[角色日志] 无法读取现有进度');
            return;
        }
        
        console.log(`[角色日志] ========== 自动更新检查 ==========`);
        console.log(`[角色日志] 对话总长度: ${context.chat.length} 楼`);
        console.log(`[角色日志] 更新阈值: ${settings.updateThreshold} 楼`);
        console.log(`[角色日志] 已有角色数: ${characterProgresses.size}`);
        
        // 🔧 修复：使用最大进度作为基准判断
        const maxProgress = characterProgresses.size > 0 
            ? Math.max(...Array.from(characterProgresses.values())) 
            : 0;
        
        console.log(`[角色日志] 全局最大进度: ${maxProgress} 楼`);
        
        // 🔧 关键修复：只看最大进度到当前楼层的差值
        const unloggedCount = context.chat.length - maxProgress;
        console.log(`[角色日志] 未记录楼层数: ${unloggedCount} 楼 (${context.chat.length} - ${maxProgress})`);
        
        const shouldUpdate = unloggedCount >= settings.updateThreshold;
        console.log(`[角色日志] 是否触发更新: ${shouldUpdate} (${unloggedCount} >= ${settings.updateThreshold})`);
        console.log(`[角色日志] =====================================`);
        
        if (shouldUpdate) {
            console.log('[角色日志] ✓ 达到阈值，触发自动更新');
            toastr.info(`达到更新阈值(${unloggedCount}楼)，自动更新角色日志...`, '角色日志');
            await executeJournalUpdate();
        } else {
            console.log(`[角色日志] ✗ 未达到阈值，跳过 (还需${settings.updateThreshold - unloggedCount}楼)`);
        }
        
    } catch (error) {
        console.error('[角色日志] 自动检查失败:', error);
    }
}

// 执行日志更新（带智能重试机制）
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
        
        console.log(`[角色日志] 手动更新: 对话总长度 ${context.chat.length} 楼`);
        console.log(`[角色日志] 已有角色数: ${characterProgresses.size}`);
        
        let updateRanges = [];
        
        if (characterProgresses.size > 0) {
            // ✅ 修复：找出最大进度
            const maxProgress = Math.max(...Array.from(characterProgresses.values()));
            const allCharacters = Array.from(characterProgresses.keys());
            
            console.log(`[角色日志] 所有角色的最大进度: ${maxProgress}楼`);
            console.log(`[角色日志] 🔧 将调用AI识别 ${maxProgress + 1}楼往后出场的角色（包括已有角色）`);
            
            // 🔧 核心修复：从最大进度往后，让AI识别每个范围内实际出场的角色（包括已有角色）
            let currentFloor = maxProgress + 1;
            while (currentFloor <= context.chat.length) {
                const batchEnd = Math.min(currentFloor + settings.updateThreshold - 1, context.chat.length);
                
                updateRanges.push({
                    characters: null, // 让AI识别所有出场角色
                    startFloor: currentFloor,
                    endFloor: batchEnd,
                    isExisting: false
                    // ✅ 修复：不传 existingCharacters，让AI识别所有出场角色（包括已有的）
                });
                
                console.log(`[角色日志] 添加AI识别范围: ${currentFloor}-${batchEnd}楼 (AI将识别所有实际出场的角色)`);
                currentFloor = batchEnd + 1;
            }
            
            if (updateRanges.length === 0) {
                toastr.info('所有已跟踪的角色日志都是最新的', '角色日志');
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
        
        console.log(`[角色日志] 总共 ${rangeMap.size} 个更新任务`);
        
        // 🎯 修复：记录真正失败的情况（AI识别出场但生成失败，或API错误）
        const failedRanges = [];
        
        // 执行更新
        let totalSuccessCount = 0;
        let taskIndex = 0;
        for (const range of rangeMap.values()) {
            taskIndex++;
            const taskInfo = range.characters 
                ? `更新 ${range.characters.join(', ')} (${range.startFloor}-${range.endFloor}楼)`
                : `AI识别并生成 (${range.startFloor}-${range.endFloor}楼)`;
            
            console.log(`[角色日志] 任务 ${taskIndex}/${rangeMap.size}: ${taskInfo}`);
            
            // 传递range对象，其中可能包含existingCharacters信息
            const journals = await generateCharacterJournals(range.startFloor, range.endFloor, range);
            
            if (!journals || journals.size === 0) {
                console.log('[角色日志] 本任务未生成任何日志（可能无角色出场）');
                // ❌ 不再将"未生成日志"视为失败，因为可能是真的没有角色出场
                continue;
            }
            
            // 更新每个角色的日志条目
            for (const [charName, journalContent] of journals.entries()) {
                const success = await updateCharacterJournal(charName, journalContent, range.startFloor, range.endFloor);
                if (success) {
                    totalSuccessCount++;
                    console.log(`[角色日志] ✓ 成功更新: ${charName}`);
                } else {
                    // 🔧 只有当角色被AI识别出场但更新失败时，才记为失败
                    console.error(`[角色日志] ✗ 更新失败: ${charName}`);
                    failedRanges.push({
                        range: range,
                        expectedCount: 1,
                        actualCount: 0,
                        successChars: [],
                        failedChars: [charName]
                    });
                }
            }
            
            console.log(`[角色日志] 本任务成功更新 ${journals.size} 个角色`);
        }
        
        console.log('[角色日志] 手动更新全部完成');
        
        // 🎯 如果有失败的范围，弹窗询问是否重试
        if (failedRanges.length > 0) {
            await showRetryDialog(failedRanges, 'manual');
        } else if (totalSuccessCount > 0) {
            toastr.success(`成功更新了 ${totalSuccessCount} 个角色的日志`, '角色日志');
            await updateStatus();
            return true;
        } else {
            toastr.warning('未能生成任何日志', '角色日志');
            return false;
        }
        
        await updateStatus();
        return totalSuccessCount > 0;
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
        let maxProgress = 0;
        try {
            const bookData = await loadWorldInfo(lorebookName);
            if (bookData && bookData.entries) {
                const journalEntries = Object.values(bookData.entries).filter(
                    e => e.comment && e.comment.startsWith(JOURNAL_COMMENT_PREFIX) && !e.disable
                );
                
                trackedCharacters = journalEntries.map(entry => {
                    const charName = entry.comment.replace(JOURNAL_COMMENT_PREFIX, '');
                    const match = entry.content.match(PROGRESS_SEAL_REGEX);
                    const progress = match ? parseInt(match[1], 10) : 0;
                    
                    // 更新最大进度
                    if (progress > maxProgress) {
                        maxProgress = progress;
                    }
                    
                    return { name: charName, progress: progress };
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
        
        // 计算自动触发信息
        const unloggedCount = totalMessages - maxProgress;
        const needMoreFloors = Math.max(0, settings.updateThreshold - unloggedCount);
        const nextTriggerFloor = maxProgress + settings.updateThreshold;
        
        let statusHtml = '';
        
        // 已记录/待记录状态
        if (trackedCharacters.length > 0) {
            statusHtml += `<strong>📝 记录状态：</strong><br>`;
            statusHtml += `• ✓ 已记录: 1-${maxProgress} 楼<br>`;
            if (unloggedCount > 0) {
                statusHtml += `• ⏳ 待记录: ${maxProgress + 1}-${totalMessages} 楼 (共 ${unloggedCount} 楼)<br>`;
            }
            statusHtml += `<br>`;
        }
        
        // 自动触发状态
        if (settings.enabled && settings.autoUpdate) {
            statusHtml += `<strong>🎯 自动触发：</strong><br>`;
            statusHtml += `• 自动触发阈值: ${settings.updateThreshold} 楼<br>`;
            
            if (unloggedCount >= settings.updateThreshold) {
                statusHtml += `• <span style="color: #27ae60; font-weight: bold;">✓ 已达到阈值，将在下次消息时触发</span><br>`;
            } else if (trackedCharacters.length > 0) {
                statusHtml += `• 还需 <strong>${needMoreFloors}</strong> 楼触发自动更新<br>`;
                statusHtml += `• 预计触发楼层: 第 <strong>${nextTriggerFloor}</strong> 楼<br>`;
            } else {
                statusHtml += `• 暂无角色日志，将在首次达到阈值时自动识别角色<br>`;
            }
            statusHtml += `<br>`;
        } else if (settings.enabled && !settings.autoUpdate) {
            statusHtml += `<strong>🎯 自动触发：</strong><br>`;
            statusHtml += `• <span style="color: #999;">自动更新未启用</span><br>`;
            statusHtml += `<br>`;
        }
        
        // 当前状态
        statusHtml += `<strong>当前状态：</strong><br>`;
        statusHtml += `• 功能状态: ${settings.enabled ? '✓ 已启用' : '✗ 未启用'}<br>`;
        statusHtml += `• 世界书: ${lorebookName}<br>`;
        statusHtml += `• 对话长度: ${totalMessages} 楼<br>`;
        statusHtml += `• 跟踪角色数: ${trackedCharacters.length}<br>`;
        statusHtml += `<br>`;
        
        // 各角色进度
        statusHtml += `<strong>📊 各角色进度：</strong><br>`;
        
        if (trackedCharacters.length > 0) {
            for (const char of trackedCharacters) {
                const percentage = totalMessages > 0 ? Math.round((char.progress / totalMessages) * 100) : 0;
                statusHtml += `• ${char.name}: ${char.progress}/${totalMessages} 楼 (${percentage}%)<br>`;
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
    $('#cj_auto_update').prop('checked', settings.autoUpdate);
    $('#cj_use_worldinfo').prop('checked', settings.useWorldInfo);
    
    // 加载智能过滤设置
    $('#cj_filter_enabled').prop('checked', settings.filterEnabled !== undefined ? settings.filterEnabled : true);
    $('#cj_min_appearances').val(settings.minAppearances !== undefined ? settings.minAppearances : 5);
    
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
    settings.autoUpdate = $('#cj_auto_update').prop('checked');
    settings.useWorldInfo = $('#cj_use_worldinfo').prop('checked');
    
    // 保存智能过滤设置
    settings.filterEnabled = $('#cj_filter_enabled').prop('checked');
    settings.minAppearances = parseInt($('#cj_min_appearances').val());
    
    settings.updateThreshold = parseInt($('#cj_update_threshold').val());
    settings.journalPrompt = $('#cj_journal_prompt').val();
    
    settings.autoRefine = $('#cj_auto_refine').prop('checked');
    settings.refineThreshold = parseInt($('#cj_refine_threshold').val());
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
    
    // 创建输入对话框（支持拖拽和最小化）
    const modalHtml = `
        <div class="character-journal-modal" id="batch_update_modal">
            <div class="character-journal-modal-content" style="max-width: 500px;" data-draggable="true">
                <div class="character-journal-modal-header">
                    <h2>📦 批量更新日志</h2>
                    <div class="character-journal-modal-controls">
                        <button class="character-journal-modal-control-btn minimize" id="minimize_batch_modal" title="最小化">
                            <span>−</span>
                        </button>
                    </div>
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
    
    // 初始化拖拽和最小化功能
    initModalDragAndMinimize('#batch_update_modal');
}

// 通用的弹窗拖拽和最小化功能
function initModalDragAndMinimize(modalSelector) {
    const modal = $(modalSelector);
    const modalContent = modal.find('.character-journal-modal-content');
    const modalHeader = modal.find('.character-journal-modal-header');
    const minimizeBtn = modal.find('#minimize_batch_modal');
    
    let isMinimized = false;
    let isDragging = false;
    let currentX, currentY, initialX, initialY;
    let xOffset = 0, yOffset = 0;
    
    // 最小化/恢复功能
    minimizeBtn.on('click', function(e) {
        e.stopPropagation();
        
        if (isMinimized) {
            // 恢复
            modalContent.removeClass('minimized');
            modal.removeClass('minimized');
            $(this).html('<span>−</span>').attr('title', '最小化');
            isMinimized = false;
        } else {
            // 最小化
            modalContent.addClass('minimized');
            modal.addClass('minimized');
            $(this).html('<span>□</span>').attr('title', '恢复');
            isMinimized = true;
        }
    });
    
    // 拖拽功能
    modalHeader.on('mousedown', function(e) {
        // 如果点击的是按钮，不触发拖拽
        if ($(e.target).closest('.character-journal-modal-control-btn').length > 0) {
            return;
        }
        
        isDragging = true;
        modalContent.addClass('draggable');
        
        // 如果是居中状态，切换到固定定位
        if (modalContent.css('position') !== 'fixed') {
            const rect = modalContent[0].getBoundingClientRect();
            xOffset = rect.left;
            yOffset = rect.top;
            modalContent.css({
                'position': 'fixed',
                'left': xOffset + 'px',
                'top': yOffset + 'px',
                'margin': '0'
            });
        } else {
            xOffset = parseInt(modalContent.css('left')) || 0;
            yOffset = parseInt(modalContent.css('top')) || 0;
        }
        
        initialX = e.clientX - xOffset;
        initialY = e.clientY - yOffset;
    });
    
    $(document).on('mousemove', function(e) {
        if (isDragging) {
            e.preventDefault();
            
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            
            xOffset = currentX;
            yOffset = currentY;
            
            setTranslate(currentX, currentY, modalContent[0]);
        }
    });
    
    $(document).on('mouseup', function() {
        if (isDragging) {
            isDragging = false;
            modalContent.removeClass('draggable');
        }
    });
    
    function setTranslate(xPos, yPos, el) {
        el.style.left = xPos + 'px';
        el.style.top = yPos + 'px';
    }
}

// 手动生成指定角色的日志
async function generateForSpecificCharacter() {
    const characterName = $('#cj_manual_character_name').val().trim();
    const messageCount = parseInt($('#cj_manual_message_count').val());
    const context = getContext();
    
    if (!characterName) {
        toastr.warning('请输入角色名称', '角色日志');
        return;
    }
    
    if (!context.chat || context.chat.length === 0) {
        toastr.warning('当前没有对话', '角色日志');
        return;
    }
    
    if (isNaN(messageCount) || messageCount < 5 || messageCount > 200) {
        toastr.error('消息数必须在5-200之间', '角色日志');
        return;
    }
    
    const totalMessages = context.chat.length;
    const endFloor = totalMessages;
    const startFloor = Math.max(1, endFloor - messageCount + 1);
    
    console.log(`[角色日志] 手动生成 ${characterName} 的日志: 读取第${startFloor}-${endFloor}楼`);
    
    try {
        toastr.info(`正在为 ${characterName} 生成日志...`, '角色日志');
        
        // 构建rangeInfo，指定角色
        const rangeInfo = {
            characters: [characterName],
            startFloor: startFloor,
            endFloor: endFloor,
            isExisting: false
        };
        
        // 调用生成函数
        const journals = await generateCharacterJournals(startFloor, endFloor, rangeInfo);
        
        if (!journals || journals.size === 0) {
            toastr.warning(`未能为 ${characterName} 生成日志（可能该角色未出场或被过滤）`, '角色日志');
            return;
        }
        
        // 检查是否成功生成了指定角色的日志
        if (!journals.has(characterName)) {
            toastr.warning(`未能为 ${characterName} 生成日志（可能未出场或不符合条件）`, '角色日志');
            return;
        }
        
        const journalContent = journals.get(characterName);
        
        // 更新或创建该角色的日志条目
        const success = await updateCharacterJournal(characterName, journalContent, startFloor, endFloor);
        
        if (success) {
            toastr.success(`成功为 ${characterName} 生成日志！`, '角色日志');
            await updateStatus();
            
            // 清空输入框
            $('#cj_manual_character_name').val('');
        }
    } catch (error) {
        console.error('[角色日志] 手动生成失败:', error);
        toastr.error(`生成失败: ${error.message}`, '角色日志');
    }
}

// 执行批量更新（✅ 统一AI识别版：与自动/手动更新逻辑一致）
async function executeBatchUpdate(startFloor, endFloor) {
    const settings = extension_settings[extensionName];
    const threshold = settings.updateThreshold;
    const lorebookName = await getTargetLorebookName();
    
    console.log(`[角色日志] ========== 批量更新 ==========`);
    console.log(`[角色日志] 用户选定范围: ${startFloor}-${endFloor}楼`);
    console.log(`[角色日志] 更新阈值: ${threshold}楼/批`);
    
    // ✅ 核心逻辑：统一使用AI识别，无论是否已有角色
    // 与自动/手动更新保持完全一致
    const updateRanges = [];
    
    // 按阈值分批处理用户选定的范围
    let currentFloor = startFloor;
    while (currentFloor <= endFloor) {
        const batchEnd = Math.min(currentFloor + threshold - 1, endFloor);
        
        updateRanges.push({
            characters: null, // 统一让AI识别所有出场角色（包括已有的）
            startFloor: currentFloor,
            endFloor: batchEnd,
            isExisting: false
            // 🔧 关键：不传existingCharacters，让AI识别所有角色
        });
        
        console.log(`[角色日志] 添加AI识别范围: ${currentFloor}-${batchEnd}楼`);
        currentFloor = batchEnd + 1;
    }
    
    console.log(`[角色日志] 总共 ${updateRanges.length} 个AI识别任务`);
    console.log(`[角色日志] ===================================`);
    
    let completedTasks = 0;
    const totalTasks = updateRanges.length;
    
    // 更新进度显示
    function updateProgress(current, total, info) {
        const percentage = Math.round((current / total) * 100);
        $('#batch_progress_fill').css('width', `${percentage}%`);
        $('#batch_progress_text').text(`${percentage}%`);
        $('#batch_progress_info').html(info);
    }
    
    // 执行所有AI识别任务
    for (let i = 0; i < updateRanges.length; i++) {
        const range = updateRanges[i];
        const taskInfo = `AI识别并生成 (${range.startFloor}-${range.endFloor}楼)`;
        
        console.log(`[角色日志] 任务 ${i + 1}/${updateRanges.length}: ${taskInfo}`);
        updateProgress(i, updateRanges.length, `任务 ${i + 1}/${updateRanges.length}: ${taskInfo}`);
        
        const journals = await generateCharacterJournals(range.startFloor, range.endFloor, range);
        
        if (journals && journals.size > 0) {
            for (const [charName, journalContent] of journals.entries()) {
                await updateCharacterJournal(charName, journalContent, range.startFloor, range.endFloor);
            }
            console.log(`[角色日志] 本任务成功更新 ${journals.size} 个角色: ${Array.from(journals.keys()).join(', ')}`);
        } else {
            console.log('[角色日志] 本任务未生成任何日志（可能无角色出场）');
        }
        
        completedTasks++;
        updateProgress(completedTasks, updateRanges.length, `✓ 已完成 ${completedTasks}/${updateRanges.length} 个任务`);
        
        // 短暂延迟避免API限流
        if (i < updateRanges.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    console.log('[角色日志] 批量更新全部完成');
    console.log('[角色日志] ===================================');
}

// 🎯 显示重试对话框
async function showRetryDialog(failedRanges, updateType) {
    console.log('[角色日志] 显示重试对话框，失败范围数:', failedRanges.length);
    
    // 构建失败信息
    let failureInfo = '';
    let totalFailed = 0;
    
    for (const fail of failedRanges) {
        const range = fail.range;
        failureInfo += `<div style="margin-bottom: 10px; padding: 10px; background: #fff3cd; border-radius: 4px;">`;
        failureInfo += `<strong>📍 范围: ${range.startFloor}-${range.endFloor}楼</strong><br>`;
        
        if (fail.expectedCount > 0) {
            failureInfo += `<span style="color: #856404;">预期更新 ${fail.expectedCount} 个角色，实际成功 ${fail.actualCount} 个</span><br>`;
        }
        
        if (fail.successChars.length > 0) {
            failureInfo += `<span style="color: #27ae60;">✓ 成功: ${fail.successChars.join(', ')}</span><br>`;
        }
        
        if (fail.failedChars.length > 0) {
            failureInfo += `<span style="color: #e74c3c;">✗ 失败: ${fail.failedChars.join(', ')}</span>`;
            totalFailed += fail.failedChars.length;
        }
        
        failureInfo += `</div>`;
    }
    
    const modalHtml = `
        <div class="character-journal-modal" id="retry_dialog_modal">
            <div class="character-journal-modal-content" style="max-width: 600px;">
                <div class="character-journal-modal-header">
                    <h2>⚠️ 日志更新部分失败</h2>
                </div>
                <div class="character-journal-modal-body">
                    <div style="margin-bottom: 15px;">
                        <p style="color: #856404; font-weight: bold;">
                            检测到 ${failedRanges.length} 个范围的更新未完全成功，共 ${totalFailed} 个角色失败。
                        </p>
                        <p style="color: #666;">
                            可能原因：AI未能为该角色生成日志（角色未出场、被过滤等）
                        </p>
                    </div>
                    
                    <div style="max-height: 300px; overflow-y: auto; margin-bottom: 15px;">
                        ${failureInfo}
                    </div>
                    
                    <div style="padding: 10px; background: #e3f2fd; border-radius: 4px; margin-bottom: 15px;">
                        <strong>🔄 重试说明：</strong><br>
                        • 系统将只针对<strong>失败的角色</strong>重新生成日志<br>
                        • 已成功的角色<strong>不会重复追加</strong><br>
                        • 重试时会使用相同的楼层范围
                    </div>
                    
                    <div style="text-align: center; font-size: 16px; font-weight: bold; color: #333;">
                        是否重试这些失败的角色？
                    </div>
                </div>
                <div class="character-journal-modal-footer">
                    <button class="character-journal-btn" id="cancel_retry">取消</button>
                    <button class="character-journal-btn success" id="confirm_retry">是，重试</button>
                </div>
            </div>
        </div>
    `;
    
    $('body').append(modalHtml);
    
    // 等待用户响应
    return new Promise((resolve) => {
        $('#confirm_retry').on('click', async function() {
            $('#retry_dialog_modal').remove();
            
            // 执行重试
            toastr.info('开始重试失败的角色...', '角色日志');
            await retryFailedRanges(failedRanges);
            
            resolve(true);
        });
        
        $('#cancel_retry').on('click', function() {
            $('#retry_dialog_modal').remove();
            toastr.info('已取消重试', '角色日志');
            resolve(false);
        });
        
        // 点击背景取消
        $('#retry_dialog_modal').on('click', function(e) {
            if (e.target.id === 'retry_dialog_modal') {
                $(this).remove();
                toastr.info('已取消重试', '角色日志');
                resolve(false);
            }
        });
    });
}

// 🎯 重试失败的范围（只重试失败的角色）
async function retryFailedRanges(failedRanges) {
    let totalRetrySuccess = 0;
    let totalRetryFailed = 0;
    
    for (const fail of failedRanges) {
        const range = fail.range;
        const failedChars = fail.failedChars;
        
        if (failedChars.length === 0) continue;
        
        console.log(`[角色日志] 重试范围 ${range.startFloor}-${range.endFloor}，失败的角色:`, failedChars);
        toastr.info(`重试 ${range.startFloor}-${range.endFloor}楼 (${failedChars.join(', ')})`, '角色日志');
        
        // 🔧 关键：只为失败的角色重新生成日志
        const retryRange = {
            characters: failedChars, // 只重试失败的角色
            startFloor: range.startFloor,
            endFloor: range.endFloor,
            isExisting: true,
            isRetry: true // 标记为重试
        };
        
        try {
            const journals = await generateCharacterJournals(range.startFloor, range.endFloor, retryRange);
            
            if (journals && journals.size > 0) {
                // 更新每个成功生成的角色
                for (const [charName, journalContent] of journals.entries()) {
                    const success = await updateCharacterJournal(charName, journalContent, range.startFloor, range.endFloor);
                    if (success) {
                        totalRetrySuccess++;
                        console.log(`[角色日志] ✓ 重试成功: ${charName}`);
                    } else {
                        totalRetryFailed++;
                        console.log(`[角色日志] ✗ 重试仍失败: ${charName}`);
                    }
                }
            } else {
                console.log(`[角色日志] ✗ 重试范围 ${range.startFloor}-${range.endFloor} 仍未生成日志`);
                totalRetryFailed += failedChars.length;
            }
        } catch (error) {
            console.error(`[角色日志] 重试范围 ${range.startFloor}-${range.endFloor} 时出错:`, error);
            totalRetryFailed += failedChars.length;
        }
        
        // 短暂延迟避免API限流
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // 显示重试结果
    if (totalRetrySuccess > 0 && totalRetryFailed === 0) {
        toastr.success(`重试成功！更新了 ${totalRetrySuccess} 个角色的日志`, '角色日志');
    } else if (totalRetrySuccess > 0 && totalRetryFailed > 0) {
        toastr.warning(`重试部分成功：成功 ${totalRetrySuccess} 个，仍失败 ${totalRetryFailed} 个`, '角色日志');
    } else {
        toastr.error(`重试失败：所有角色仍未能生成日志`, '角色日志');
    }
    
    await updateStatus();
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
    
    // 刷新状态按钮
    $('#cj_refresh_status').on('click', async function() {
        console.log('[角色日志] 用户点击刷新状态按钮');
        const btn = $(this);
        const originalText = btn.html();
        btn.prop('disabled', true).html('🔄 刷新中...');
        
        try {
            await updateStatus();
            toastr.success('状态已刷新', '角色日志');
        } catch (error) {
            console.error('[角色日志] 刷新状态失败:', error);
            toastr.error('刷新失败: ' + error.message, '角色日志');
        } finally {
            btn.prop('disabled', false).html(originalText);
        }
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
    console.log('[角色日志] ========== 调试信息 ==========');
    console.log('[角色日志] eventSource 类型:', typeof eventSource);
    console.log('[角色日志] eventSource 值:', eventSource);
    console.log('[角色日志] event_types 类型:', typeof event_types);
    console.log('[角色日志] event_types.MESSAGE_RECEIVED:', event_types?.MESSAGE_RECEIVED);
    console.log('[角色日志] event_types.CHARACTER_SELECTED:', event_types?.CHARACTER_SELECTED);
    console.log('[角色日志] ====================================');
    
    if (!eventSource || !event_types) {
        console.error('[角色日志] ❌ 事件系统导入失败！');
        console.error('[角色日志] eventSource:', eventSource);
        console.error('[角色日志] event_types:', event_types);
        toastr.error('角色日志系统：事件系统导入失败', '扩展错误');
        return;
    }
    
    console.log('[角色日志] ✓ 开始注册事件监听器');
        
    eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
            const settings = extension_settings[extensionName];
            if (settings.enabled) {
                updateStatus();
                
                // 自动更新功能
                if (settings.autoUpdate) {
                    await checkAndAutoUpdate();
                }
            }
    });
    
    eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
        updateStatus();
    });
    
    // 监听角色切换事件（正确的事件是 CHAT_CHANGED）
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        try {
            console.log('[角色日志] ========== 🔔 CHAT_CHANGED 事件触发 ==========');
            
            const settings = extension_settings[extensionName];
            console.log('[角色日志] 功能启用状态:', settings?.enabled);
            console.log('[角色日志] 目标模式:', settings?.target);
            
            if (settings.enabled && settings.target === "character_main") {
                const context = getContext();
                const newCharName = context.name2 || "角色";
                console.log(`[角色日志] 新角色: ${newCharName}`);
                
                // 自动切换世界书
                try {
                    const newWorldbook = await getTargetLorebookName();
                    console.log(`[角色日志] ✓ 成功切换到世界书: ${newWorldbook}`);
                    
                    // 刷新状态显示
                    await updateStatus();
                    
                    toastr.info(`已加载 ${newWorldbook}`, '角色日志');
                } catch (wbError) {
                    console.error('[角色日志] ✗ 切换世界书失败:', wbError);
                    console.error('[角色日志] 错误堆栈:', wbError.stack);
                }
            } else {
                console.log('[角色日志] 跳过角色切换处理（功能未启用或不在character_main模式）');
            }
            
            console.log('[角色日志] ========================================');
        } catch (error) {
            console.error('[角色日志] ❌ CHARACTER_SELECTED 事件处理失败:', error);
            console.error('[角色日志] 错误堆栈:', error.stack);
        }
    });
    
    console.log('[角色日志系统] 扩展已加载');
    
    // 加载新布局处理器
    const layoutHandlerScript = document.createElement('script');
    layoutHandlerScript.src = `${extensionFolderPath}new-layout-handler.js`;
    layoutHandlerScript.type = 'text/javascript';
    document.head.appendChild(layoutHandlerScript);
    
    console.log('[角色日志系统] 新布局处理器已加载');
});

// 导出函数供新布局处理器调用
window.characterJournal = {
    saveSettings: saveSettings,
    generateForSpecificCharacter: generateForSpecificCharacter
};
