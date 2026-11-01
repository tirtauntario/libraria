export interface ArchivePage {
  filename: string;
  index: number;
  getData(): Promise<Blob>;
}

export interface ArchiveReader {
  getPages(): Promise<ArchivePage[]>;
  close(): void;
}
