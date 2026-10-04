"""vowel representative_sample_id ON DELETE SET NULL

Needed so deleting a Sample (or cascade-deleting a Language, which deletes
its Samples) that happens to be some vowel's representative doesn't raise a
FK violation — see formanter.py's DELETE /api/v1/samples/<id> and
DELETE /api/v1/languages/<id>.

Revision ID: 8a1c4e0f9b22
Revises: 6fc66a01e419
Create Date: 2026-10-04 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8a1c4e0f9b22'
down_revision: Union[str, None] = '6fc66a01e419'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint('vowels_representative_sample_id_fkey', 'vowels', type_='foreignkey')
    op.create_foreign_key(
        'vowels_representative_sample_id_fkey', 'vowels', 'samples',
        ['representative_sample_id'], ['id'], ondelete='SET NULL',
    )


def downgrade() -> None:
    op.drop_constraint('vowels_representative_sample_id_fkey', 'vowels', type_='foreignkey')
    op.create_foreign_key(
        'vowels_representative_sample_id_fkey', 'vowels', 'samples',
        ['representative_sample_id'], ['id'],
    )
