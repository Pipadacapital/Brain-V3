/**
 * PixelStatus — domain entity tracking pixel verification state.
 *
 * State reflects ACTUAL backend verification (HTTP HEAD/GET check), never simulated.
 * The dashboard §6.4 reads this entity's state for the "Data Status" widget.
 */

export type PixelState = 'connected' | 'syncing' | 'waiting_for_data' | 'error';

export interface PixelStatusProps {
  readonly id: string;
  readonly brandId: string;
  readonly pixelInstallationId: string;
  readonly state: PixelState;
  readonly verifiedAt: Date | null;
  readonly lastError: string | null;
  readonly updatedAt: Date;
}

export class PixelStatus {
  readonly id: string;
  readonly brandId: string;
  readonly pixelInstallationId: string;
  readonly state: PixelState;
  readonly verifiedAt: Date | null;
  readonly lastError: string | null;
  readonly updatedAt: Date;

  private constructor(props: PixelStatusProps) {
    this.id = props.id;
    this.brandId = props.brandId;
    this.pixelInstallationId = props.pixelInstallationId;
    this.state = props.state;
    this.verifiedAt = props.verifiedAt;
    this.lastError = props.lastError;
    this.updatedAt = props.updatedAt;
  }

  static create(props: PixelStatusProps): PixelStatus {
    return new PixelStatus(props);
  }

  markVerified(): PixelStatus {
    return new PixelStatus({
      ...this.toProps(),
      state: 'connected',
      verifiedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    });
  }

  markError(message: string): PixelStatus {
    return new PixelStatus({
      ...this.toProps(),
      state: 'error',
      lastError: message,
      updatedAt: new Date(),
    });
  }

  toProps(): PixelStatusProps {
    return {
      id: this.id,
      brandId: this.brandId,
      pixelInstallationId: this.pixelInstallationId,
      state: this.state,
      verifiedAt: this.verifiedAt,
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    };
  }
}
