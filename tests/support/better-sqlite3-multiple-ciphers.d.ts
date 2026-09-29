declare module 'better-sqlite3-multiple-ciphers' {
  type Statement = { get(...params: unknown[]): unknown }

  export default class Database {
    constructor(path: string, options?: { readonly?: boolean; fileMustExist?: boolean })
    pragma(source: string, options?: { simple?: boolean }): unknown
    prepare(source: string): Statement
    close(): void
  }
}
