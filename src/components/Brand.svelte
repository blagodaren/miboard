<script lang="ts">
  const name = 'MIBoard'
</script>

<div class="brand">
  <img src="./favicon.svg" alt="" width="32" height="32" class="brand-icon" />
  <span class="brand-name">{name}</span>
</div>

<style>
  .brand {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 10px;
  }

  .brand-icon {
    display: block;
    flex-shrink: 0;
  }

  .brand-name {
    color: var(--text);
    font-size: 17px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: -0.035em;
  }
</style>
