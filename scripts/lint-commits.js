import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COMMIT_TYPES = [
  'feat',
  'fix',
  'perf',
  'docs',
  'refactor',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
  'security'
];

// Regex matching: type(scope)?: description or type!: description
const COMMIT_REGEX = /^([a-z]+)(?:\(([a-z0-9_-]+)\))?(!?): (.+)$/;

export function validateCommitMessage(message) {
  const lines = message.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { valid: false, error: 'Commit message is empty' };
  }

  const subject = lines[0];
  const match = COMMIT_REGEX.exec(subject);
  if (!match) {
    return {
      valid: false,
      error: 'Subject line does not match Conventional Commits format: "type(scope)?: description"'
    };
  }

  const [_, type, scope, breaking, description] = match;

  if (!COMMIT_TYPES.includes(type)) {
    return {
      valid: false,
      error: `Invalid commit type "${type}". Allowed types are: ${COMMIT_TYPES.join(', ')}`
    };
  }

  if (subject.length > 72) {
    return {
      valid: false,
      error: 'Subject line exceeds maximum length of 72 characters'
    };
  }

  // Check for breaking change footer if present
  let hasBreakingFooter = false;
  if (lines.length > 1) {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].startsWith('BREAKING CHANGE:') || lines[i].startsWith('BREAKING-CHANGE:')) {
        hasBreakingFooter = true;
        break;
      }
    }
  }

  return {
    valid: true,
    details: { type, scope, isBreaking: breaking === '!' || hasBreakingFooter, description }
  };
}

// If run as a CLI tool (e.g. from git hook or CI)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const commitMsgFile = process.argv[2];
  let commitMsgText = '';

  if (commitMsgFile) {
    if (fs.existsSync(commitMsgFile)) {
      commitMsgText = fs.readFileSync(commitMsgFile, 'utf8');
    } else {
      commitMsgText = commitMsgFile; // fallback to treating argument as direct message
    }
  } else {
    // Read from stdin if no file passed
    try {
      commitMsgText = fs.readFileSync(0, 'utf-8');
    } catch (_) {
      console.error('Usage: node scripts/lint-commits.js <commit-msg-file-path-or-text>');
      process.exit(1);
    }
  }

  const result = validateCommitMessage(commitMsgText);
  if (!result.valid) {
    console.error('\x1b[31m%s\x1b[0m', 'Conventional Commits Validation Error:');
    console.error('\x1b[31m%s\x1b[0m', result.error);
    console.error('Commit Message was:');
    console.error(commitMsgText);
    process.exit(1);
  } else {
    console.log('\x1b[32m%s\x1b[0m', '✓ Commit message matches Conventional Commits format.');
    process.exit(0);
  }
}
