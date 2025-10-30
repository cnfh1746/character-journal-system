# Character Journal System - Design Document

## Overview
A SillyTavern extension that creates individual diary/journal entries for each character in the conversation. Each character maintains their own first-person perspective memory, which is activated only when that character appears, saving tokens and improving roleplay consistency.

## Core Concept

### The Problem
- Current worldbook summaries are third-person and generic
- All summaries activate together, wasting tokens
- Hard to maintain character-specific perspectives and emotions
- Difficult to track individual character growth

### The Solution
- **Character-specific journal entries**: Each character has their own worldbook entry
- **First-person perspective**: Entries are written as if the character is writing a diary
- **Selective activation**: Only activates when that specific character appears (via keywords)
- **Single API call**: One request generates journals for all active characters

## Architecture

### Data Structure

```
Character Journal Entry:
├─ Comment: "【Character Journal】Alice"
├─ Keywords: ["Alice", "艾丽丝"] (character names)
├─ Content:
│  ├─ Recent Memories (last 5-10 entries)
│  │  ├─ Floor 241-250: [First-person diary entry]
│  │  ├─ Floor 251-260: [First-person diary entry]
│  │  └─ ...
│  └─ Progress Seal: "【Journal updated through floor 260】"
├─ Activation: Keyword-based (character name)
└─ Settings:
   ├─ excludeRecursion: true
   ├─ preventRecursion: true
   └─ order: 90 (high priority)

Character Archive Entry (optional):
├─ Comment: "【Character Archive】Alice"
├─ Keywords: ["Alice档案", "Alice profile"]
├─ Content:
│  ├─ Personality traits
│  ├─ Important relationships
│  ├─ Key experiences
│  └─ Character growth summary
└─ Activation: Separate keywords to avoid overlap
```

### System Components

#### 1. Character Detection Module
```javascript
function detectCharacters(messages) {
    // Identify all characters who appeared in the conversation
    // Return: [{ name, displayName, messageCount }]
}
```

#### 2. Journal Generation Module
```javascript
async function generateCharacterJournals(messages, characters) {
    // Single API call with structured prompt
    // Generates first-person journals for each character
    // Return: Map<characterName, journalContent>
}
```

#### 3. Entry Management Module
```javascript
async function updateCharacterJournals(journalMap, startFloor, endFloor) {
    // Find or create entries for each character
    // Append new journals to existing entries
    // Maintain progress seals
}
```

#### 4. Archive & Refinement Module
```javascript
async function refineCharacterJournal(characterName) {
    // Triggered when journal exceeds threshold (e.g., 5000 chars)
    // Extract key information to archive entry
    // Keep only recent N entries in journal
}
```

## Prompt Engineering

### Main Prompt Template

```markdown
You are a memory recording assistant. Analyze the conversation and write first-person diary entries for each character.

**Characters to track:**
- Alice
- Bob  
- Carl

**Instructions:**
1. Write from each character's perspective (I, me, my)
2. Capture their thoughts, feelings, and observations
3. Keep each entry 50-100 words
4. If a character didn't appear, write: 【Not present this round】

**Output Format:**

===Character:Alice===
[Alice's first-person diary entry about what happened and how she feels]
===Character:Bob===
[Bob's first-person diary entry]
===Character:Carl===
【Not present this round】
===END===

**Conversation:**
[Floor 241-250 messages here]
```

### Refinement Prompt Template

```markdown
You are a character profile analyst. Refine the following journal entries into a concise character profile.

**Task:**
Extract and organize:
1. Core personality traits
2. Key relationships and feelings toward others
3. Important experiences that shaped the character
4. Character growth and changes

**Input:**
[Full journal content]

**Output Format:**
【Personality】
[2-3 sentences]

【Relationships】
- Character X: [relationship status and feelings]
- Character Y: [relationship status and feelings]

【Key Experiences】
- [Important event 1]
- [Important event 2]

【Character Growth】
[How the character has changed from start to now]
```

## Settings Interface

```yaml
Character Journal Settings:
  enabled: boolean
  
  Character List:
    - Auto-detect from conversation
    - Manual list (comma-separated)
    
  Journal Style:
    - narrative: "Today I met..."
    - emotional: Focus on feelings
    - analytical: Thoughts and analysis
    
  Update Trigger:
    - with_small_summary: Update together with plot summary
    - independent: Separate trigger threshold
    
  Threshold:
    - update_threshold: 20 messages (when to generate new entries)
    - refinement_threshold: 5000 characters (when to compress)
    
  Worldbook Settings:
    - target: character_main | dedicated
    - activation_mode: keyword (always)
    - keywords_template: "{character_name}, {character_alias}"
```

## Workflow

### Normal Flow

1. **Message Received** → Check if threshold reached
2. **Generate Request** → Build prompt with character list
3. **API Call** → Single request for all characters
4. **Parse Response** → Extract individual journal entries
5. **Update Entries** → Find/create entries, append content
6. **Check Size** → If > threshold, trigger refinement

### Refinement Flow

1. **Size Check** → Journal entry exceeds character limit
2. **Extract Content** → Get all journal entries
3. **Refine** → Generate compressed profile
4. **Update Archive** → Save to archive entry
5. **Trim Journal** → Keep only recent N entries

## Token Optimization

### Before (Traditional Summary)
```
All summaries loaded: ~5000 tokens
├─ Plot summary: 2000 tokens
├─ Character relationships: 1500 tokens
├─ World info: 1000 tokens
└─ Misc: 500 tokens
```

### After (Character Journals)
```
Only relevant character loaded: ~800 tokens
├─ Alice's journal (if Alice appears): 500 tokens
├─ Alice's archive (if needed): 300 tokens
└─ Other characters: 0 tokens (not activated)

Token saved: ~84% when only 1-2 characters active
```

## Error Handling

### Character Misidentification
- **Issue**: AI confuses character A with character B
- **Solution**: 
  - Strict format with character name markers
  - Validation step to check if extracted names match expected list
  - Manual override option in settings

### Missing Entries
- **Issue**: Character mentioned in chat but no journal entry exists
- **Solution**:
  - Auto-create entry on first detection
  - Backfill option to generate retrospective journal

### Content Overflow
- **Issue**: Journal grows too large
- **Solution**:
  - Automatic refinement at threshold
  - Archive old content
  - Option to manually trigger cleanup

## API Efficiency

### Single Request Strategy
```javascript
// One API call generates all character journals
const response = await callAI([
  { role: 'system', content: systemPrompt },
  { role: 'user', content: conversationContext }
]);

// Parse structured output
const journals = parseCharacterJournals(response);
// journals = {
//   "Alice": "Today I felt...",
//   "Bob": "That girl seems...",
//   "Carl": "【Not present this round】"
// }
```

### Fallback Strategy
```javascript
// If parsing fails, retry with simplified prompt
// Or fall back to individual requests (less efficient)
```

## Implementation Phases

### Phase 1: MVP (Minimum Viable Product)
- [ ] Character detection from chat
- [ ] Single API call for multiple characters
- [ ] Parse and split character journals
- [ ] Create/update worldbook entries
- [ ] Basic settings UI

### Phase 2: Enhancement
- [ ] Auto-refinement when size threshold reached
- [ ] Archive entry system
- [ ] Multiple journal style presets
- [ ] Manual character list management

### Phase 3: Advanced Features
- [ ] Character relationship graph
- [ ] Emotion tracking over time
- [ ] Export journals as readable format
- [ ] Integration with vector database for long-term memory

## Testing Strategy

### Test Cases

1. **Single Character**
   - One character active in conversation
   - Verify journal entry created
   - Check keyword activation

2. **Multiple Characters**
   - 3+ characters in conversation
   - Verify all journals generated in single request
   - Check no cross-contamination

3. **Character Not Present**
   - Character in tracking list but not in current segment
   - Should generate "Not present" marker
   - Should not update that character's entry unnecessarily

4. **Large Journal**
   - Simulate 10+ updates to one character
   - Trigger refinement threshold
   - Verify archive creation and journal trimming

5. **Concurrent Updates**
   - Multiple messages in quick succession
   - Ensure no duplicate entries
   - Proper serialization of updates

## Performance Considerations

### Memory
- Each entry: ~1-5KB
- 10 characters: ~50KB total
- Minimal impact on system memory

### API Calls
- Baseline: 1 call per update cycle (regardless of character count)
- Refinement: +1 call per character when threshold reached
- Typical usage: 1 call per 20 messages

### Disk I/O
- Write to worldbook: Once per update
- Read from worldbook: On initialization and status check
- Minimal due to batching

## Future Enhancements

1. **Multi-dimensional Tracking**
   - Separate entries for emotions, goals, relationships
   - Each dimension as separate optional entry

2. **Timeline Integration**
   - Visual timeline of character's journey
   - Link journal entries to specific story beats

3. **Conflict Detection**
   - Alert when character behavior contradicts past entries
   - Suggest consistency improvements

4. **Natural Language Queries**
   - Ask: "How does Alice feel about Bob?"
   - Search through journals to answer

5. **Export & Share**
   - Export as PDF or markdown
   - Share character journals with others
   - Import journals from other chats

## Success Metrics

- **Token Efficiency**: >70% reduction when only 1-2 characters active
- **Roleplay Quality**: Subjective improvement in character consistency
- **User Satisfaction**: Positive feedback on character depth
- **Performance**: <2s for journal generation and update
- **Reliability**: <1% error rate in character misidentification

## Conclusion

The Character Journal System provides a token-efficient, roleplay-enhancing alternative to traditional summaries. By maintaining individual character perspectives and using selective activation, it significantly reduces context usage while improving character consistency and
