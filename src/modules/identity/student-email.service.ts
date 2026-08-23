import { BadRequestException, Injectable } from '@nestjs/common';
import { parseStudentDomains } from '../../shared/config/configuration.js';

/**
 * Service-layer enforcement of the student email domain rule
 * (AGENTS.md: validated in service layer AND DB trigger).
 * Domains come from STUDENT_DOMAINS env (default ui.ac.id).
 */
@Injectable()
export class StudentEmailService {
  private readonly pattern: RegExp;
  private readonly domainsLabel: string;

  constructor() {
    const domains = parseStudentDomains(process.env.STUDENT_DOMAINS);
    this.domainsLabel = domains.join('|');
    const escaped = domains.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    this.pattern = new RegExp(`@(${escaped.join('|')})$`, 'i');
  }

  isValidStudentEmail(email: string): boolean {
    return this.pattern.test(email.trim());
  }

  assertValidStudentEmail(email: string): void {
    if (!this.isValidStudentEmail(email)) {
      throw new BadRequestException(`Student email must end with @${this.domainsLabel}`);
    }
  }
}
