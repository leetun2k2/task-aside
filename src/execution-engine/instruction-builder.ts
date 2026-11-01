// Instruction builder for execution engine (ARCHITECTURE.md §5, SPECIFICATION.md §2, §3; TASKS.md T20).
// Assembles bounded instructions from task, repository scope, parent context, conversation history,
// and non-negotiable safety guidelines.
import type { Message } from '../contracts/chat.ts';
import { ROUTING_INSTRUCTION_MARKDOWN } from './routing-instruction.ts';
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

/** Intake's prompt (specs/2026-10-25-message-intake/03-agent-routing.md):
 * the versioned routing instruction, the authorized repo catalog (metadata
 * only — never a filesystem scan), and this conversation's bounded history,
 * always including the initial Message. No repository-isolation or
 * code-editing guidance belongs here — Intake has no write tools. */
export function buildIntakeInstruction(context: TaskContext, options: InstructionOptions = {}): string {
  const { task, authorizedRepositories, messages } = context;

  const catalog = (authorizedRepositories ?? [])
    .map((r) => `- \`${r.id}\` — ${r.name} (default provider: ${r.defaultProvider})`)
    .join('\n');

  const sections: string[] = [
    ROUTING_INSTRUCTION_MARKDOWN,
    `## Current task
- **Task ID**: ${task.id}
- **Submitted title**: ${task.title ? task.title : '*(none — auto-resolve)*'}
- **Submitted priority**: ${task.priority ?? '*(none — auto-resolve, not an override)*'}
- **Repo hints**: ${task.candidateRepoIds && task.candidateRepoIds.length > 0 ? task.candidateRepoIds.join(', ') : '*(none)*'}
- **Parent task ID**: ${task.parentId ?? '*(none)*'}`,
    `## Authorized repository catalog
${catalog || '*(no registered repositories are authorized for this task)*'}`,
    `## Conversation history (this conversation only)
${formatConversationHistory(messages, options)}`,
  ];

  return sections.join('\n\n');
}

export function buildInstruction(context: TaskContext, options: InstructionOptions = {}): string {
  const { task, repository, parent, messages } = context;
  if (!repository) {
    throw new Error(
      `buildInstruction requires a resolved repository (task ${task.id} is still stage 'intake')`,
    );
  }

  const sections: string[] = [];

  // 1. Task Header. The goal itself is the task's initial Message, which is
  // always present in "Conversation History" below (specs/2026-10-25-
  // message-intake/01-contracts-and-lifecycle.md "Always include the
  // initial Message in Intake context, even when older history is
  // truncated" — the same invariant applies to the implementation prompt;
  // `description` is a removed, legacy-only field).
  const title = task.title.trim();

  sections.push(`# Task: ${title}
- **Task ID**: ${task.id}
- **Priority**: ${task.priority}
- **Status**: ${task.status}
- **Depth**: ${task.depth}`);

  // 2. Repository Scope
  const allRepos =
    context.resolvedRepositories && context.resolvedRepositories.length > 0
      ? context.resolvedRepositories
      : [repository];
  const repoListLines = allRepos
    .map((r) => `- **${r.name}** (\`${r.id}\`): \`${r.canonicalPath}\``)
    .join('\n');
  const allowedRootsStr = allRepos.map((r) => `\`${r.canonicalPath}\``).join(' and ');

  const boundaryNote =
    allRepos.length > 1
      ? `Primary working directory: \`${repository.canonicalPath}\`.\nAllowed project roots: ${allowedRootsStr}.\nYou MUST confine all file edits and inspection strictly to the allowed project roots. Use an explicit working directory for commands in each repository. Do not inspect or modify unrelated project directories, follow links outside this scope, or request broader permissions. If another repository is needed, stop and report the missing scope.`
      : `You MUST confine all file edits and inspection strictly to this repository path. Do not touch or modify any files outside this directory.`;

  sections.push(`## Repository Scope
- **Primary Working Directory**: \`${repository.canonicalPath}\`
${repoListLines}

${boundaryNote}`);

  // 3. Parent Task Context (if this is a child task). The parent's own goal
  // is its initial Message, in its own separate conversation unless shared
  // (04-delegation-and-follow-up.md) — not fetched here.
  if (parent) {
    sections.push(`## Parent Task Context
This task was delegated as a subtask of the parent task below.
- **Parent ID**: ${parent.id}
- **Parent Title**: ${parent.title}
- **Parent Priority**: ${parent.priority}`);
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
1. **Working Tree Isolation**: All actions must be contained within the allowed project roots (${allowedRootsStr}). Do not inspect or modify directories outside this scope.
2. **No Unauthorized Commits/Pushes**: Do not run \`git commit\`, \`git push\`, or modify git remote configurations unless explicitly instructed.
3. **No Destructive Commands**: Do not run destructive git operations (such as \`git reset --hard\`, \`git clean -fdx\`) or destructive deletions (\`rm -rf\`).
4. **Human In The Loop**: If user input, clarifications, or design decisions are needed, formulate a clear question for the user rather than guessing or proceeding with destructive assumptions.
5. **Goal Completion**: Focus strictly on achieving the task goal. Verify changes before concluding.`);
  }

  return sections.join('\n\n');
}

export const buildTaskInstruction = buildInstruction;
