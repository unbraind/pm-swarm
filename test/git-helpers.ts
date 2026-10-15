import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { git } from '../src/git.ts';

/** Refuse inherited parent repositories before a fixture can mutate Git state. */
export function assertFixtureRepo(repo: string): void {
  assert.equal(realpathSync(git(repo, ['rev-parse', '--show-toplevel'])), realpathSync(repo), 'Fixture Git root escaped its temporary repository');
}

/** Initialize only the explicit fixture path and guard every later Git operation. */
export function fixtureGit(repo: string, args: string[], input?: string): string {
  if (args[0] === 'init') {
    const result = git(repo, [...args, repo], input);
    assertFixtureRepo(repo);
    return result;
  }
  assertFixtureRepo(repo);
  return git(repo, args, input);
}
