export interface ReadInput {
  path: string
  /** 1-based inclusive line number. */
  start_line?: number
  /** Maximum number of lines to return from start_line. */
  line_count?: number
  /** Maximum number of characters returned after line slicing. */
  max_chars?: number
}
export interface ReadResult {
  path: string
  content: string
  start_line: number
  end_line: number
  total_lines: number
  truncated: boolean
}
export interface ReadManyInput {
  files: ReadInput[]
}
export interface ReadManyResult {
  results: ReadResult[]
}
export interface ReadImageInput {
  path: string
}
export type SupportedImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
export interface ReadImageMetrics {
  resolveMs: number
  readMs: number
  inspectMs: number
  transformMs: number
  base64Ms: number
  totalMs: number
}
export interface ReadImageResult {
  /** Workspace-relative for relative inputs; resolved absolute path for absolute inputs. */
  path: string
  data: string
  mimeType: SupportedImageMimeType
  /** Bytes actually transmitted after optional optimization. */
  bytes: number
  originalBytes: number
  originalWidth?: number
  originalHeight?: number
  width?: number
  height?: number
  compressed: boolean
  metrics: ReadImageMetrics
}
export interface WriteInput {
  path: string
  content: string
}
export interface WriteResult {
  path: string
  bytes: number
}
export interface EditInput {
  path: string
  old_string: string
  new_string: string
}
export interface EditResult {
  path: string
  matches: 1
}
export interface EditManyInput {
  edits: EditInput[]
}
export interface EditManyResult {
  results: EditResult[]
}
export interface BashInput {
  command: string
  timeout_ms?: number
  /** Maximum combined stdout and stderr characters returned. */
  max_output_chars?: number
}
export interface BashResult {
  exit_code: number | null
  stdout: string
  stderr: string
  truncated: boolean
}
