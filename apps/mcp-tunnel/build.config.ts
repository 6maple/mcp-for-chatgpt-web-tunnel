import { defineBuildConfig } from 'unbuild'
export default defineBuildConfig({
  entries: ['src/index', 'src/server', 'src/external-mcp-registry'],
  declaration: false,
  clean: true,
})
