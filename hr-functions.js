/**
 * CLARA — HR Functions
 * Employee management, leave tracking, onboarding, performance reviews,
 * document management, and payroll preparation.
 */

'use strict';
const crypto = require('crypto');

// ── Employee Database (in-memory, move to Postgres in production) ────────────

const employees = new Map();

/**
 * Add a new employee.
 */
function addEmployee(data) {
  const id = 'EMP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const employee = {
    id,
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email,
    department: data.department || 'General',
    role: data.role || 'Employee',
    startDate: data.startDate || new Date().toISOString().split('T')[0],
    salary: data.salary || 0,
    currency: data.currency || 'USD',
    employmentType: data.employmentType || 'full-time', // full-time, part-time, contractor
    manager: data.manager || null,
    location: data.location || 'Remote',
    status: 'active',
    leaveBalance: { annual: 25, sick: 10, personal: 3 },
    documents: [],
    performanceReviews: [],
    onboardingChecklist: generateOnboardingChecklist(),
    createdAt: new Date().toISOString()
  };
  employees.set(id, employee);
  return employee;
}

function getEmployee(id) { return employees.get(id) || null; }

function listEmployees(filters = {}) {
  let list = Array.from(employees.values());
  if (filters.department) list = list.filter(e => e.department === filters.department);
  if (filters.status) list = list.filter(e => e.status === filters.status);
  if (filters.location) list = list.filter(e => e.location === filters.location);
  return list;
}

function updateEmployee(id, updates) {
  const emp = employees.get(id);
  if (!emp) return null;
  const BLOCKED = ['__proto__', 'constructor', 'prototype'];
  const safe = {};
  for (const k of Object.keys(updates || {})) {
    if (!BLOCKED.includes(k)) safe[k] = updates[k];
  }
  Object.assign(emp, safe, { updatedAt: new Date().toISOString() });
  return emp;
}

function terminateEmployee(id, reason, lastDay) {
  const emp = employees.get(id);
  if (!emp) return null;
  emp.status = 'terminated';
  emp.terminationReason = reason;
  emp.lastDay = lastDay || new Date().toISOString().split('T')[0];
  emp.terminatedAt = new Date().toISOString();
  return emp;
}

// ── Leave Management ────────────────────────────────────────────────────────

const leaveRequests = new Map();

function requestLeave(employeeId, type, startDate, endDate, notes) {
  const emp = employees.get(employeeId);
  if (!emp) throw new Error('Employee not found');

  const days = Math.ceil((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)) + 1;
  if (emp.leaveBalance[type] !== undefined && days > emp.leaveBalance[type]) {
    throw new Error(`Insufficient ${type} leave balance. Available: ${emp.leaveBalance[type]}, Requested: ${days}`);
  }

  const id = 'LV-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const request = {
    id, employeeId, employeeName: `${emp.firstName} ${emp.lastName}`,
    type, startDate, endDate, days, notes,
    status: 'pending', // pending, approved, rejected, cancelled
    requestedAt: new Date().toISOString()
  };
  leaveRequests.set(id, request);
  return request;
}

function approveLeave(requestId, approverId) {
  const req = leaveRequests.get(requestId);
  if (!req) throw new Error('Leave request not found');
  req.status = 'approved';
  req.approvedBy = approverId;
  req.approvedAt = new Date().toISOString();

  // Deduct from balance
  const emp = employees.get(req.employeeId);
  if (emp && emp.leaveBalance[req.type] !== undefined) {
    emp.leaveBalance[req.type] -= req.days;
  }
  return req;
}

function rejectLeave(requestId, reason) {
  const req = leaveRequests.get(requestId);
  if (!req) throw new Error('Leave request not found');
  req.status = 'rejected';
  req.rejectionReason = reason;
  return req;
}

function getLeaveRequests(filters = {}) {
  let list = Array.from(leaveRequests.values());
  if (filters.employeeId) list = list.filter(r => r.employeeId === filters.employeeId);
  if (filters.status) list = list.filter(r => r.status === filters.status);
  return list.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
}

// ── Onboarding Checklist ────────────────────────────────────────────────────

function generateOnboardingChecklist() {
  return [
    { task: 'Sign employment contract', status: 'pending', category: 'Legal' },
    { task: 'Complete tax forms (W-4 / P45)', status: 'pending', category: 'Tax' },
    { task: 'Set up bank account for payroll', status: 'pending', category: 'Payroll' },
    { task: 'Receive laptop and equipment', status: 'pending', category: 'IT' },
    { task: 'Set up email and platform accounts', status: 'pending', category: 'IT' },
    { task: 'Complete security training', status: 'pending', category: 'Compliance' },
    { task: 'Review company handbook', status: 'pending', category: 'HR' },
    { task: 'Meet team members', status: 'pending', category: 'Culture' },
    { task: 'First week check-in with manager', status: 'pending', category: 'Management' },
    { task: 'Set up benefits enrollment', status: 'pending', category: 'Benefits' }
  ];
}

function updateOnboardingTask(employeeId, taskIndex, status) {
  const emp = employees.get(employeeId);
  if (!emp || !emp.onboardingChecklist[taskIndex]) return null;
  emp.onboardingChecklist[taskIndex].status = status;
  emp.onboardingChecklist[taskIndex].completedAt = status === 'complete' ? new Date().toISOString() : null;
  return emp.onboardingChecklist;
}

// ── Performance Reviews ─────────────────────────────────────────────────────

function createReview(employeeId, reviewerId, period, ratings, comments) {
  const emp = employees.get(employeeId);
  if (!emp) throw new Error('Employee not found');

  const review = {
    id: 'REV-' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    employeeId,
    reviewerId,
    period, // e.g. 'Q1 2026', 'Annual 2025'
    ratings: {
      performance: ratings.performance || 3, // 1-5
      communication: ratings.communication || 3,
      initiative: ratings.initiative || 3,
      teamwork: ratings.teamwork || 3,
      technical: ratings.technical || 3,
      overall: ratings.overall || 3
    },
    comments: comments || '',
    goals: [],
    status: 'draft', // draft, submitted, acknowledged
    createdAt: new Date().toISOString()
  };

  emp.performanceReviews.push(review);
  return review;
}

// ── Payroll Preparation ─────────────────────────────────────────────────────

function preparePayroll(month, year) {
  const activeEmployees = Array.from(employees.values()).filter(e => e.status === 'active');

  const payroll = activeEmployees.map(emp => {
    const monthlySalary = emp.salary / 12;
    const leaveTaken = Array.from(leaveRequests.values())
      .filter(r => r.employeeId === emp.id && r.status === 'approved')
      .filter(r => {
        const d = new Date(r.startDate);
        return d.getMonth() + 1 === month && d.getFullYear() === year;
      })
      .reduce((s, r) => s + r.days, 0);

    return {
      employeeId: emp.id,
      name: `${emp.firstName} ${emp.lastName}`,
      department: emp.department,
      grossSalary: Math.round(monthlySalary * 100) / 100,
      currency: emp.currency,
      leaveDays: leaveTaken,
      deductions: {
        tax: Math.round(monthlySalary * 0.25 * 100) / 100, // Placeholder
        socialSecurity: Math.round(monthlySalary * 0.0765 * 100) / 100,
        benefits: Math.round(monthlySalary * 0.05 * 100) / 100
      },
      netPay: Math.round(monthlySalary * (1 - 0.25 - 0.0765 - 0.05) * 100) / 100
    };
  });

  return {
    period: `${year}-${String(month).padStart(2, '0')}`,
    employeeCount: payroll.length,
    totalGross: payroll.reduce((s, p) => s + p.grossSalary, 0),
    totalNet: payroll.reduce((s, p) => s + p.netPay, 0),
    totalDeductions: payroll.reduce((s, p) => s + p.deductions.tax + p.deductions.socialSecurity + p.deductions.benefits, 0),
    entries: payroll
  };
}

// ── HR Dashboard Stats ──────────────────────────────────────────────────────

function getHRStats() {
  const all = Array.from(employees.values());
  const active = all.filter(e => e.status === 'active');
  const pending = Array.from(leaveRequests.values()).filter(r => r.status === 'pending');

  return {
    totalEmployees: all.length,
    activeEmployees: active.length,
    departments: [...new Set(active.map(e => e.department))],
    pendingLeaveRequests: pending.length,
    averageSalary: active.length > 0 ? Math.round(active.reduce((s, e) => s + e.salary, 0) / active.length) : 0,
    headcountByDepartment: active.reduce((acc, e) => { acc[e.department] = (acc[e.department] || 0) + 1; return acc; }, {}),
    recentHires: active.filter(e => {
      const d = new Date(e.startDate);
      return Date.now() - d.getTime() < 90 * 24 * 60 * 60 * 1000;
    }).length
  };
}

module.exports = {
  addEmployee, getEmployee, listEmployees, updateEmployee, terminateEmployee,
  requestLeave, approveLeave, rejectLeave, getLeaveRequests,
  generateOnboardingChecklist, updateOnboardingTask,
  createReview,
  preparePayroll,
  getHRStats
};
