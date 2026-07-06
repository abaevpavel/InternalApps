import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Button, Dropdown, Field, Input, Modal, Textarea } from '../../components/ui'
import { errMsg } from '../../lib/utils'
import { createChecklist, createEmployee } from '../../services/hr-checklists'
import { EMPLOYEE_TYPES, type EmployeeType } from '../../domain/hr-checklists'

/* ---------------- Create employee ---------------- */

export function CreateEmployeeDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (employeeId: string) => void
}) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [type, setType] = useState<EmployeeType>('Office employee')
  const [startDate, setStartDate] = useState('')
  const [terminationDate, setTerminationDate] = useState('')

  const createM = useMutation({
    mutationFn: () =>
      createEmployee({
        first_name: firstName,
        last_name: lastName,
        employee_type: type,
        start_date: startDate || undefined,
        termination_date: terminationDate || null,
      }),
    onSuccess: (emp) => onCreated(emp.id),
  })

  const valid = firstName.trim() && lastName.trim()

  return (
    <Modal
      open
      title="Create New Employee"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="blue" disabled={!valid || createM.isPending} onClick={() => createM.mutate()}>
            Create Employee
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First Name" required>
            <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
          </Field>
          <Field label="Last Name" required>
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </Field>
        </div>
        <Field label="Employee Type" required>
          <Dropdown
            value={type}
            onChange={setType}
            options={EMPLOYEE_TYPES.map((t) => ({ value: t, label: t }))}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date">
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="Termination date">
            <Input type="date" value={terminationDate} onChange={(e) => setTerminationDate(e.target.value)} />
          </Field>
        </div>
        {createM.error && <p className="text-sm text-red-600">{errMsg(createM.error)}</p>}
      </div>
    </Modal>
  )
}

/* ---------------- Add checklist (template) ---------------- */

export function AddChecklistDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const createM = useMutation({
    mutationFn: () => createChecklist({ name, description }),
    onSuccess: onCreated,
  })

  return (
    <Modal
      open
      title="Add Checklist"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="blue" disabled={!name.trim() || createM.isPending} onClick={() => createM.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Checklist name" autoFocus />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Optional description" />
        </Field>
        {createM.error && <p className="text-sm text-red-600">{errMsg(createM.error)}</p>}
      </div>
    </Modal>
  )
}
