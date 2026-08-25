import { defineBuildConfig } from 'unbuild'
export default defineBuildConfig({
  entries: ['src/loaders', 'src/read-image', 'src/read-many', 'src/edit-many', 'src/notify'],
  declaration: true,
  clean: true,
})
