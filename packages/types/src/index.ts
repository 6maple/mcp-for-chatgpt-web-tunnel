export interface ReadInput {
  path: string
}
export interface ReadResult {
  path: string
  content: string
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
export interface BashInput {
  command: string
  timeout_ms?: number
}
export interface BashResult {
  command: string
  cwd: string
  exit_code: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
}
