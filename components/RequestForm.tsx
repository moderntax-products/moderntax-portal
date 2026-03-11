'use client';

import { useState, useCallback } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { FormType } from '@/lib/types';

interface Entity {
  id: string;
  name: string;
  ein: string;
  formType: FormType;
  years: string[];
}

interface RequestFormProps {
  onSubmit: (data: {
    accountNumber: string;
    notes: string;
    entities: Entity[];
  }) => Promise<void>;
  isLoading?: boolean;
}

const FORM_TYPES: FormType[] = [FormType.FORM_1040, FormType.FORM_1065, FormType.FORM_1120, FormType.FORM_1120S];
const YEARS = Array.from({ length: 10 }, (_, i) =>
  (new Date().getFullYear() - i).toString()
);

export function RequestForm({ onSubmit, isLoading = false }: RequestFormProps) {
  const [accountNumber, setAccountNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [entities, setEntities] = useState<Entity[]>([
    {
      id: '1',
      name: '',
      ein: '',
      formType: FormType.FORM_1040,
      years: [],
    },
  ]);

  const handleAddEntity = useCallback(() => {
    const newId = Math.max(...entities.map((e) => parseInt(e.id)), 0) + 1;
    setEntities([
      ...entities,
      {
        id: newId.toString(),
        name: '',
        ein: '',
        formType: FormType.FORM_1040,
        years: [],
      },
    ]);
  }, [entities]);

  const handleRemoveEntity = useCallback(
    (id: string) => {
      if (entities.length > 1) {
        setEntities(entities.filter((e) => e.id !== id));
      }
    },
    [entities]
  );

  const handleEntityChange = useCallback(
    (id: string, field: keyof Entity, value: unknown) => {
      setEntities(
        entities.map((e) =>
          e.id === id ? { ...e, [field]: value } : e
        )
      );
    },
    [entities]
  );

  const handleYearToggle = useCallback(
    (entityId: string, year: string) => {
      setEntities(
        entities.map((e) => {
          if (e.id === entityId) {
            const years = e.years.includes(year)
              ? e.years.filter((y) => y !== year)
              : [...e.years, year];
            return { ...e, years };
          }
          return e;
        })
      );
    },
    [entities]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validation
    if (!accountNumber.trim()) {
      alert('Please enter an account number');
      return;
    }

    const validEntities = entities.filter((e) => e.name.trim() && e.ein.trim() && e.years.length > 0);
    if (validEntities.length === 0) {
      alert('Please add at least one entity with a name, EIN, and selected years');
      return;
    }

    try {
      await onSubmit({
        accountNumber,
        notes,
        entities: validEntities,
      });
    } catch (error) {
      console.error('Form submission error:', error);
      alert('Failed to submit request. Please try again.');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-4xl mx-auto space-y-8">
      {/* Account Number */}
      <div className="bg-white rounded-lg shadow-md p-6">
        <label className="block text-sm font-semibold text-gray-900 mb-2">
          Account Number *
        </label>
        <input
          type="text"
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
          placeholder="Enter account number"
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          disabled={isLoading}
        />
      </div>

      {/* Notes */}
      <div className="bg-white rounded-lg shadow-md p-6">
        <label className="block text-sm font-semibold text-gray-900 mb-2">
          Notes (Optional)
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add any additional notes or special instructions..."
          rows={4}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          disabled={isLoading}
        />
      </div>

      {/* Entities */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Entities *</h3>
          <button
            type="button"
            onClick={handleAddEntity}
            disabled={isLoading}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-400 text-white font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Entity
          </button>
        </div>

        {entities.map((entity, idx) => (
          <div key={entity.id} className="bg-white rounded-lg shadow-md p-6 space-y-4">
            <div className="flex justify-between items-start mb-4">
              <h4 className="font-medium text-gray-900">Entity {idx + 1}</h4>
              {entities.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleRemoveEntity(entity.id)}
                  disabled={isLoading}
                  className="text-red-500 hover:text-red-700 disabled:text-gray-400 transition-colors"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Entity Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Entity Name *
                </label>
                <input
                  type="text"
                  value={entity.name}
                  onChange={(e) => handleEntityChange(entity.id, 'name', e.target.value)}
                  placeholder="Business or individual name"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  disabled={isLoading}
                />
              </div>

              {/* EIN */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  EIN *
                </label>
                <input
                  type="text"
                  value={entity.ein}
                  onChange={(e) => handleEntityChange(entity.id, 'ein', e.target.value)}
                  placeholder="XX-XXXXXXX"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  disabled={isLoading}
                />
              </div>
            </div>

            {/* Form Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Form Type *
              </label>
              <select
                value={entity.formType}
                onChange={(e) => handleEntityChange(entity.id, 'formType', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                disabled={isLoading}
              >
                {FORM_TYPES.map((type) => (
                  <option key={type} value={type}>
                    Form {type}
                  </option>
                ))}
              </select>
            </div>

            {/* Years */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Years *
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
                {YEARS.map((year) => (
                  <label
                    key={year}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={entity.years.includes(year)}
                      onChange={() => handleYearToggle(entity.id, year)}
                      disabled={isLoading}
                      className="rounded border-gray-300"
                    />
                    <span className="text-sm text-gray-700">{year}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Submit Button */}
      <div className="flex gap-4">
        <button
          type="submit"
          disabled={isLoading}
          className="flex-1 px-6 py-3 bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-400 text-white font-semibold rounded-lg transition-colors"
        >
          {isLoading ? 'Submitting...' : 'Submit Request'}
        </button>
      </div>
    </form>
  );
}
