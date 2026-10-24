// Instruction builder for execution engine (ARCHITECTURE.md §5, SPECIFICATION.md §2, §3; TASKS.md T20).
// Assembles bounded instructions from task, repository scope, parent context, conversation history,
// and non-negotiable safety guidelines.
import type { Message } from '../contracts/chat.ts';
import type { InstructionOptions, TaskContext } from './types.ts';

const DEFAULT_MAX_HISTORY_MESSAGES = 25;
const DEFAULT_MAX_HISTORY_CHARACTERS = 12000;

export function formatConversationHistory(
  messages: Message[],
  options: InstructionOptions = {},
): string {
  if (!messages || messages.length === 0) {
    return '*(No prior conversation messages)*';
  }

  const maxMessages = options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
  const maxCharacters = options.maxHistoryCharacters ?? DEFAULT_MAX_HISTORY_CHARACTERS;

  let windowMessages = messages;
  let truncatedMessageCount = 0;

  if (messages.length > maxMessages) {
    truncatedMessageCount = messages.length - maxMessages;
    windowMessages = messages.slice(-maxMessages);
  }

  // Format messages into strings
  const formattedItems = windowMessages.map((m) => {
    const roleLabel = m.sender === 'user' ? 'User' : m.sender === 'agent' ? 'Agent' : 'System';
    const text = m.content.trim();
    return `### ${roleLabel} (${m.createdAt})\n${text}`;
  });

  // Check character budget from newest to oldest
  let totalChars = 0;
  const includedRev: string[] = [];
  let charTruncatedCount = 0;

  for (let i = formattedItems.length - 1; i >= 0; i--) {
    const item = formattedItems[i];
    if (totalChars + item.length > maxCharacters && includedRev.length > 0) {
      charTruncatedCount = i + 1;
      break;
    }
    totalChars += item.length;
    includedRev.push(item);
  }

  const finalItems = includedRev.reverse();
  const totalOmitted = truncatedMessageCount + charTruncatedCount;

  let output = '';
  if (totalOmitted > 0) {
    output += `> *[Earlier conversation history truncated (${totalOmitted} earlier message${totalOmitted > 1 ? 's' : ''} omitted for brevity)]*\n\n`;
  }

  output += finalItems.join('\n\n');
  return output;
}

export function buildInstruction(context: TaskContext, options: InstructionOptions = {}): string {
  const { task, repository, parent, messages } = context;

  const sections: string[] = [];

  // 1. Task Header & Goal
  const title = task.title.trim();
  const description = task.description?.trim() || '*(No description provided)*';

  sections.push(`# Task: ${title}
- **Task ID**: ${task.id}
- **Priority**: ${task.priority}
- **Status**: ${task.status}
- **Depth**: ${task.depth}

## Goal & Description
${description}`);

  // 2. Repository Scope
  sections.push(`## Repository Scope
- **Repository Name**: ${repository.name}
- **Working Directory**: \`${repository.canonicalPath}\`

You MUST confine all file edits and inspection strictly to this repository path. Do not touch or modify any files outside this directory.`);

  // 3. Parent Task Context (if this is a child task)
  if (parent) {
    const parentDesc = parent.description?.trim() || '*(No description provided)*';
    sections.push(`## Parent Task Context
This task was delegated as a subtask of the parent task below.
- **Parent ID**: ${parent.id}
- **Parent Title**: ${parent.title}
- **Parent Priority**: ${parent.priority}
- **Parent Goal**:
${parentDesc}`);
  }

  // 3b. Delegated Child Tasks Results (if this parent delegated subtasks)
  if (context.children && context.children.length > 0) {
    const childLines = context.children.map((c) => {
      let line = `- **Child Task**: \`${c.id}\` — *${c.title}*\n  - **Status**: ${c.status}`;
      if (c.summary) {
        line += `\n  - **Summary**: ${c.summary}`;
      }
      if (c.errorMessage) {
        line += `\n  - **Error/Reason**: ${c.errorMessage}`;
      }
      return line;
    });

    const failedChildren = context.children.filter(
      (c) => c.status === 'error' || c.status === 'cancelled',
    );
    let errorSection = '';
    if (failedChildren.length > 0) {
      errorSection = `\n\n### Child Task Failures / Cancellations
The following delegated subtasks did not complete successfully:
${failedChildren.map((f) => `- **${f.id}** (${f.status}): ${f.errorMessage ?? 'Failed'}`).join('\n')}
Review these errors and take appropriate corrective or finishing action.`;
    }

    sections.push(`## Delegated Child Tasks Results
This task previously delegated work to the following subtasks:
${childLines.join('\n\n')}${errorSection}`);
  }

  // 4. Conversation History
  const historyText = formatConversationHistory(messages, options);
  sections.push(`## Conversation History
${historyText}`);

  // 5. Safety Guidelines
  if (options.includeSafetyGuidelines !== false) {
    sections.push(`## Non-Negotiable Safety Guidelines
1. **Working Tree Isolation**: All actions must be contained within \`${repository.canonicalPath}\`. Do not inspect or modify directories outside this path.
2. **No Unauthorized Commits/Pushes**: Do not run \`git commit\`, \`git push\`, or modify git remote configurations unless explicitly instructed.
3. **No Destructive Commands**: Do not run destructive git operations (such as \`git reset --hard\`, \`git clean -fdx\`) or destructive deletions (\`rm -rf\`).
4. **Human In The Loop**: If user input, clarifications, or design decisions are needed, formulate a clear question for the user rather than guessing or proceeding with destructive assumptions.
5. **Goal Completion**: Focus strictly on achieving the task goal. Verify changes before concluding.`);
  }

  return sections.join('\n\n');
}

export const buildTaskInstruction = buildInstruction;
