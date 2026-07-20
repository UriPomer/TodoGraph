import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertCurrentVersion, assertNewerVersion, decidePublish } from '../scripts/publish.js';

describe('MCP publish workflow', () => {
  it('publishes only when the exact version is absent', () => {
    expect(decidePublish('local-sha', null)).toBe('publish');
    expect(decidePublish('same-sha', 'same-sha')).toBe('skip');
  });

  it('requires a version bump when published contents differ', () => {
    expect(() => decidePublish('local-sha', 'remote-sha')).toThrow(
      'already exists with different contents',
    );
  });

  it('prevents the npm latest tag from moving backwards', () => {
    expect(() => assertNewerVersion('0.1.1', '0.2.0')).toThrow('must be newer');
    expect(() => assertNewerVersion('0.2.0', '0.2.0')).toThrow('must be newer');
    expect(() => assertNewerVersion('0.2.1', '0.2.0')).not.toThrow();
    expect(() => assertNewerVersion('0.1.0', null)).not.toThrow();
  });

  it('rejects an identical historical package before publishing a server distribution', () => {
    expect(() => assertCurrentVersion('0.1.1', '0.2.0')).toThrow('must match npm latest');
    expect(() => assertCurrentVersion('0.2.0', '0.2.0')).not.toThrow();
  });

  it('guards every server distribution before it advertises the MCP version', () => {
    for (const workflow of ['npm-publish-mcp.yml', 'docker-publish.yml', 'release.yml']) {
      const source = readFileSync(
        new URL(`../../../.github/workflows/${workflow}`, import.meta.url),
        'utf8',
      );
      expect(source).toContain('group: todograph-mcp-publish');
      expect(source).toContain('cancel-in-progress: false');
      expect(source).not.toContain('queue:');
      expect(source).toContain('pnpm --filter @todograph/mcp publish:npm');
      if (workflow === 'docker-publish.yml') {
        expect(source.indexOf('publish:npm')).toBeLessThan(source.indexOf('name: Build and push'));
      }
    }
  });

  it('dispatches a version-tagged Docker build after a manual desktop release', () => {
    const dockerWorkflow = readFileSync(
      new URL('../../../.github/workflows/docker-publish.yml', import.meta.url),
      'utf8',
    );
    const releaseWorkflow = readFileSync(
      new URL('../../../.github/workflows/release.yml', import.meta.url),
      'utf8',
    );

    expect(dockerWorkflow).toContain('workflow_dispatch:');
    expect(dockerWorkflow).toContain('image_tag:');
    expect(dockerWorkflow).toContain('type=raw,value=${{ inputs.image_tag }}');
    expect(releaseWorkflow).toContain('actions: write');
    expect(releaseWorkflow).toContain('gh workflow run docker-publish.yml');
    expect(releaseWorkflow.indexOf('name: Create GitHub Release')).toBeLessThan(
      releaseWorkflow.indexOf('gh workflow run docker-publish.yml'),
    );
  });

  it('builds shared inside the publisher without prebuilding MCP in its workflow', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    const publishWorkflow = readFileSync(
      new URL('../../../.github/workflows/npm-publish-mcp.yml', import.meta.url),
      'utf8',
    );

    expect(manifest.scripts['publish:npm']).toContain('--filter @todograph/shared build');
    expect(publishWorkflow).not.toContain('pnpm --filter @todograph/mcp... build');
  });
});
