export interface BrokenDocLink {
  file: string;
  link: string;
}

export declare function findBrokenDocLinks(rootDir?: string): BrokenDocLink[];
