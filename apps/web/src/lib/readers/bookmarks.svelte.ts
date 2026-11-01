import type { Bookmark, Locator } from '@libraria/core';
import type { Repo } from '../db/repo';

/** Bookmarks of one book, kept fresh while a reader is open. */
export class BookmarkList {
  items = $state<Bookmark[]>([]);
  private unsubscribe: () => void;

  constructor(
    private readonly repo: Repo,
    private readonly sha512: string,
  ) {
    void this.load();
    this.unsubscribe = repo.events.subscribe((t) => {
      if (t.has('bookmarks')) void this.load();
    });
  }

  private async load() {
    this.items = await this.repo.listBookmarks(this.sha512);
  }

  find(match: (loc: Locator) => boolean): Bookmark | undefined {
    return this.items.find((b) => match(b.locator));
  }

  async add(locator: Locator, label: string): Promise<void> {
    await this.repo.addBookmark(this.sha512, locator, label);
  }

  async remove(id: string): Promise<void> {
    await this.repo.deleteBookmark(id);
  }

  destroy(): void {
    this.unsubscribe();
  }
}
