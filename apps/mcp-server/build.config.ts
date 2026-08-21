import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: ['src/index', 'src/notification'],
  declaration: false,
  clean: true,
})
