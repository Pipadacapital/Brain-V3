/**
 * ConnectorCursor — domain entity for idempotent sync cursor position.
 *
 * The (brandId, connectorInstanceId, resource) triple is the upsert key (I-ST04).
 * Replaying the same resource sync with the same cursor is safe by design.
 */

export interface ConnectorCursorProps {
  readonly id: string;
  readonly brandId: string;
  readonly connectorInstanceId: string;
  /** Resource name, e.g. 'orders', 'products', 'customers'. */
  readonly resource: string;
  /** Opaque cursor string. Null = never synced. */
  readonly cursorValue: string | null;
  readonly updatedAt: Date;
}

export class ConnectorCursor {
  readonly id: string;
  readonly brandId: string;
  readonly connectorInstanceId: string;
  readonly resource: string;
  readonly cursorValue: string | null;
  readonly updatedAt: Date;

  private constructor(props: ConnectorCursorProps) {
    this.id = props.id;
    this.brandId = props.brandId;
    this.connectorInstanceId = props.connectorInstanceId;
    this.resource = props.resource;
    this.cursorValue = props.cursorValue;
    this.updatedAt = props.updatedAt;
  }

  static create(props: ConnectorCursorProps): ConnectorCursor {
    return new ConnectorCursor(props);
  }

  advance(newCursorValue: string): ConnectorCursor {
    return new ConnectorCursor({
      ...this.toProps(),
      cursorValue: newCursorValue,
      updatedAt: new Date(),
    });
  }

  toProps(): ConnectorCursorProps {
    return {
      id: this.id,
      brandId: this.brandId,
      connectorInstanceId: this.connectorInstanceId,
      resource: this.resource,
      cursorValue: this.cursorValue,
      updatedAt: this.updatedAt,
    };
  }
}
