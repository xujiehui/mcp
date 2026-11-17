// Genome is a private, version-dependent format. Unknown properties are retained
// at this boundary; normalized outputs are assembled by the typed adapter.
export interface GenomeNode {
  id?: string;
  nodeId?: string;
  name?: string;
  type?: string;
  children?: GenomeNode[];
  [key: string]: any;
}
export interface Genome {
  pages?: GenomeNode[];
  document?: { children?: GenomeNode[] };
  images?: Record<string, any>;
  styles?: Record<string, any>;
  [key: string]: any;
}
export interface SelectionOptions {
  nodeId?: string;
  maxDepth?: number;
  maxNodes?: number;
  includeHidden?: boolean;
  cssUnit?: 'px' | 'rpx';
  cssLayout?: 'absolute' | 'auto';
  format?: 'full' | 'compact';
  fields?: string[];
  maxTextLength?: number;
  cursor?: string;
}
export interface RequestOptions { forceRefresh?: boolean; signal?: AbortSignal }
