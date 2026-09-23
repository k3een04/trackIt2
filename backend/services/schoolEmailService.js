const validator = require('validator');

/**
 * School email policy for students and coordinators.
 *
 * STI issues campus-based Microsoft 365 accounts, e.g.
 * delacruz.873612@ortigas-cainta.edu.ph  (the FAQ sample uses the
 * "@campus.edu.ph" pattern, and the older accounts used "@sti.ph").
 *
 * By default any "*.edu.ph" / "*.sti.ph" host is accepted so every campus works.
 * To lock it down to specific domains, set STI_EMAIL_DOMAINS in backend/.env,
 * for example: STI_EMAIL_DOMAINS=sti.edu.ph,ortigas-cainta.edu.ph
 */

const DEFAULT_ALLOWED_HOSTS = [/(^|\.)edu\.ph$/i, /(^|\.)sti\.ph$/i];

const SCHOOL_EMAIL_EXAMPLE = 'delacruz.873612@ortigas-cainta.edu.ph';
const SCHOOL_EMAIL_HINT = `Students and coordinators must sign up with the STI email given by the school (example: ${SCHOOL_EMAIL_EXAMPLE}).`;

// The exact hosts allowed, from STI_EMAIL_DOMAINS when configured
function getAllowedHosts() {
  const configured = String(process.env.STI_EMAIL_DOMAINS || '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

  return configured.length > 0 ? configured : DEFAULT_ALLOWED_HOSTS;
}

// True when the address is a valid email on an allowed school domain
function isSchoolEmail(email) {
  if (!email || typeof email !== 'string') {
    return false;
  }

  return validator.isEmail(email, { host_whitelist: getAllowedHosts() });
}

// Message shown to students/coordinators when the domain is not accepted
function getSchoolEmailError() {
  const hosts = getAllowedHosts().filter((host) => typeof host === 'string');
  const domainList = hosts.length > 0 ? ` (allowed domains: ${hosts.join(', ')})` : '';

  return `Please use your STI email address, for example ${SCHOOL_EMAIL_EXAMPLE}${domainList}.`;
}

module.exports = {
  SCHOOL_EMAIL_EXAMPLE,
  SCHOOL_EMAIL_HINT,
  getAllowedHosts,
  isSchoolEmail,
  getSchoolEmailError,
};
