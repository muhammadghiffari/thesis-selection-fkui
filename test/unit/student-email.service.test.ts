import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { StudentEmailService } from '../../src/modules/identity/student-email.service.js';

function service(env?: string): StudentEmailService {
  if (env === undefined) delete process.env.STUDENT_DOMAINS;
  else process.env.STUDENT_DOMAINS = env;
  return new StudentEmailService();
}

afterEach(() => delete process.env.STUDENT_DOMAINS);

describe('StudentEmailService', () => {
  it('accepts @ui.ac.id emails by default', () => {
    expect(service().isValidStudentEmail('budi.santoso@ui.ac.id')).toBe(true);
  });

  it('rejects non-student domains and lookalikes', () => {
    const svc = service();
    expect(svc.isValidStudentEmail('budi@gmail.com')).toBe(false);
    expect(() => svc.assertValidStudentEmail('spoof@ui.ac.id.evil.com')).toThrow(BadRequestException);
    // subdomain trickery must not pass
    expect(svc.isValidStudentEmail('x@evil-ui.ac.id')).toBe(false);
  });

  it('honours STUDENT_DOMAINS override', () => {
    const svc = service('ui.ac.id,student.ac.id');
    expect(svc.isValidStudentEmail('a@student.ac.id')).toBe(true);
    expect(svc.isValidStudentEmail('a@gmail.com')).toBe(false);
  });
});
