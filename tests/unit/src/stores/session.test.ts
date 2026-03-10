import { describe, it, expect, vi } from 'vitest';
import { getProjectName } from '../../../../src/stores/session';

vi.mock('solid-js/store', () => ({
  createStore: vi.fn((initial: any) => [initial, vi.fn()]),
}));

describe('getProjectName', () => {
  it.each([
    [{ name: 'MyProject', directory: '/any/path' }, 'MyProject'],
    [{ name: '', directory: '/home/user/project' }, 'project'],
    [{ name: '', directory: 'C:\\Users\\dev\\myapp' }, 'myapp'],
    [{ name: '', directory: '/home/user/project/' }, 'project'],
    [{ name: '', directory: '/' }, 'Unknown'],
    [{ name: '', directory: '' }, 'Unknown'],
    [{ name: '', directory: '/mixed\\separators/path' }, 'path'],
  ] as [any, string][])('getProjectName(%j) returns "%s"', (project, expected) => {
    expect(getProjectName(project)).toBe(expected);
  });
});
