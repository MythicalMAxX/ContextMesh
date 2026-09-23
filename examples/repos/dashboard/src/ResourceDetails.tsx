// Frontend for the resource details page (UI-492). The agent building this asks the network for the
// contract of GET /api/resources/{id} instead of asking the backend developer.
export function statusLabel(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return 'Active';
    case 'INACTIVE':
      return 'Inactive';
    default:
      return status;
  }
}
