import { createContext, useContext, type ReactNode } from 'react'
import { FormProvider, type FieldValues, type UseFormReturn } from 'react-hook-form'
export const FormSubmissionContext = createContext({ isSubmitting: false })
export const useFormSubmissionState = () => useContext(FormSubmissionContext)
export function Form<T extends FieldValues>({ form, onSubmit, children, className = 'space-y-6', pending = false }: {
  form: UseFormReturn<T>; onSubmit: (data: T) => void | Promise<void>; children: ReactNode; className?: string; pending?: boolean
}) {
  return <FormSubmissionContext.Provider value={{ isSubmitting: pending || form.formState.isSubmitting }}><FormProvider {...form}><form noValidate onSubmit={form.handleSubmit(onSubmit)} className={className}>{children}</form></FormProvider></FormSubmissionContext.Provider>
}
