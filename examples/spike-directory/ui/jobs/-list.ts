import { list } from './-model'
export default list(['title', 'client_id', 'priority', 'status'], { orderBy: 'title', search: ['title'], source: 'ui/jobs/-list.ts' })
