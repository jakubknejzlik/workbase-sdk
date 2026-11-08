// Known instance identifiers and domain vocabulary; Unicode word boundaries keep
// generic identifiers such as technicianName and reception_id out of the scan.
export const forbiddenInstanceTerms = ['tiketo', 'infodental', 'controldental', 'cleaning', 'dentist', 'service-requests', 'service_requests', 'servicerequests', 'surgery', 'saddler', 'implant', 'stump', 'lab_choice', 'ordinace', 'sedlář', 'pahýl', 'implantát', 'za lékaře', 'doctor', 'reception', 'technician', 'surgery_user', 'Lékař', 'Recepce', 'Technik', 'per_doctor', 'per_surgery'] as const
const escapedTerms = forbiddenInstanceTerms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
export const instanceNames = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escapedTerms.join('|')})(?![\\p{L}\\p{N}_])`, 'iu')

export const consolePrivateTerms = /tiketo|infodental|cleaning|service[-_]requests|loyalty_|tooth_|surgery_|patient_|\b(?:controldental|knejzlik|orbi|teamvibe)\b/i
export const privateBrand = /tiketo(?:cz)?/iu
