/**
 * Mapovanie identity z Portos GET /api/v1/identities (getStatus().identity) na polia company_profiles.
 */

function normalizeText(value) {
  return String(value ?? '').trim();
}

function buildAddress(address) {
  if (!address || typeof address !== 'object') return '';

  const street = [address.streetName, address.buildingNumber, address.propertyRegistrationNumber]
    .filter(Boolean)
    .join(' ')
    .trim();
  const locality = [
    address.deliveryAddress?.postalCode || address.postalCode || '',
    address.municipality || '',
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  return [street, locality, address.country]
    .filter(Boolean)
    .join(', ')
    .trim();
}

export function mapPortosIdentityFromStatus(status) {
  const identity = status?.identity || {};
  const organizationUnit = identity.organizationUnit || {};

  return {
    businessName: normalizeText(identity.corporateBodyFullName),
    ico: normalizeText(identity.ico),
    dic: normalizeText(identity.dic),
    icDph: normalizeText(identity.icdph),
    registeredAddress: buildAddress(identity.physicalAddress),
    branchName: normalizeText(organizationUnit.organizationUnitName),
    branchAddress: buildAddress(organizationUnit.physicalAddress),
    cashRegisterCode: normalizeText(status?.cashRegisterCode || organizationUnit.cashRegisterCode),
  };
}

/**
 * Úplná aktualizácia identifikačných polí z Portos; kontakty z DB zachováme (nie sú v Portos identite).
 */
export function mergePortosIdentityIntoProfileRow(portosFields, existingRow) {
  const keepPhone = normalizeText(existingRow?.contactPhone);
  const keepEmail = normalizeText(existingRow?.contactEmail);

  return {
    ...portosFields,
    contactPhone: keepPhone,
    contactEmail: keepEmail,
  };
}

export function hasUsablePortosIdentity(status) {
  if (!status?.serviceReachable) return false;
  if (!status.identity || typeof status.identity !== 'object') return false;
  const p = mapPortosIdentityFromStatus(status);
  return Boolean(p.ico || p.businessName || p.cashRegisterCode);
}
